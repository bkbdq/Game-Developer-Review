import { recordAudit } from './audit.js';

const API_BASE = 'https://api.github.com';

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export function fail(status, message, extra = {}) {
  return json({ ok: false, message, ...extra }, status);
}

/**
 * 用管理员粘贴的 GitHub PAT 校验身份与数据仓写权限。
 * 成功返回 { login, token }；失败返回 { error: Response }。
 */
async function deny(env, request, token, status, message, reviewer = '') {
  // 只记录带了凭证但校验失败的尝试，避免匿名探测刷日志
  if (token && env.DB) {
    let path = '';
    try {
      path = new URL(request.url).pathname;
    } catch {
      path = '';
    }
    await recordAudit(env.DB, {
      action: path === '/api/admin/me' ? 'login_denied' : 'auth_denied',
      reviewer,
      result: 'denied',
      targetType: 'session',
      targetId: path || null,
      reason: message,
      details: path ? { path } : null,
    });
  }
  return { error: fail(status, message) };
}

export async function authenticate(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return { error: fail(401, '缺少登录凭证') };

  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  if (!owner || !repo) return { error: fail(500, '缺少 GITHUB_OWNER / GITHUB_REPO 配置') };

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'gdr-admin-api',
  };

  const [userResponse, repoResponse] = await Promise.all([
    fetch(`${API_BASE}/user`, { headers }),
    fetch(`${API_BASE}/repos/${owner}/${repo}`, { headers }),
  ]);

  if (userResponse.status === 401) return deny(env, request, token, 401, 'token 无效或已过期');
  if (!userResponse.ok) return { error: fail(502, '无法校验 GitHub 身份') };
  if (!repoResponse.ok) {
    return deny(env, request, token, 403, 'token 无权访问数据仓库；协作者请使用 classic token（repo scope）');
  }

  const [user, repository] = await Promise.all([userResponse.json(), repoResponse.json()]);
  if (repository.permissions?.push !== true) {
    return deny(env, request, token, 403, 'token 缺少数据仓库写权限；协作者请使用 classic token（repo scope）', user.login);
  }

  const allowed = (env.ADMIN_LOGINS || '').split(',').map(item => item.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(user.login)) {
    return deny(env, request, token, 403, '该账号不在管理员白名单中', user.login);
  }

  return { login: user.login };
}

export function readInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), min), max);
}
