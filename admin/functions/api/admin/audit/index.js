import { authenticate, json, fail, readInt } from '../../../_lib/auth.js';
import { listAuditLog } from '../../../_lib/store.js';
import { recordAudit } from '../../../_lib/audit.js';

const ACTION = /^[a-z][a-z_]{1,39}$/;
const DEPLOY_ACTIONS = new Set(['deploy_showcase']);

function normalizeTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function onRequestGet({ request, env }) {
  const session = await authenticate(request, env);
  if (session.error) return session.error;
  if (!env.DB) return fail(500, '缺少 D1 绑定 DB');

  const url = new URL(request.url);
  const action = (url.searchParams.get('action') || '').trim();
  const reviewer = (url.searchParams.get('reviewer') || '').trim();
  if (action && !ACTION.test(action)) return fail(400, 'action 不合法');
  if (reviewer.length > 39) return fail(400, 'reviewer 过长');

  const from = normalizeTime(url.searchParams.get('from'));
  const to = normalizeTime(url.searchParams.get('to'));
  if (from === null || to === null) return fail(400, '时间格式不合法');

  const limit = readInt(url.searchParams.get('limit'), 50, 1, 200);
  const offset = readInt(url.searchParams.get('offset'), 0, 0, 100000);

  const result = await listAuditLog(env.DB, { action, reviewer, from, to, limit, offset });
  return json({ ok: true, ...result });
}

export async function onRequestPost({ request, env }) {
  const session = await authenticate(request, env);
  if (session.error) return session.error;
  if (!env.DB) return fail(500, '缺少 D1 绑定 DB');

  let body = null;
  try {
    body = await request.json();
  } catch {
    return fail(400, '请求体不是合法 JSON');
  }

  if (!DEPLOY_ACTIONS.has(body?.action)) return fail(400, '未知操作');

  const result = body.result === 'failed' ? 'failed' : 'success';
  const note = String(body.note || '').slice(0, 500);

  await recordAudit(env.DB, {
    action: body.action,
    reviewer: session.login,
    result,
    targetType: 'deploy',
    targetId: 'gdr-site',
    reason: note || null,
  });

  return json({ ok: true });
}
