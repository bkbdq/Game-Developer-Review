// 会话内缓存已通过校验的登录身份，避免每次页面跳转都重新请求 /api/admin/me。
// 只缓存登录名与时间，不保存 token；过期或 token 失效后仍由后端接口兜底校验。
const KEY = 'gdr.admin.session';
const MAX_AGE = 10 * 60 * 1000;

export function getSession() {
  try {
    const data = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (!data || typeof data.login !== 'string' || !data.login) return null;
    if (!Number.isFinite(data.at) || Date.now() - data.at > MAX_AGE) return null;
    return { login: data.login, at: data.at };
  } catch {
    return null;
  }
}

export function setSession(login) {
  if (!login) return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ login, at: Date.now() }));
  } catch {
    // 隐私模式下 sessionStorage 可能不可用，忽略即可
  }
}

export function clearSession() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // 忽略
  }
}
