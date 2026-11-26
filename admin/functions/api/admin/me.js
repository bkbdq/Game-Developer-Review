import { authenticate, json } from '../../_lib/auth.js';
import { recordAudit } from '../../_lib/audit.js';

export async function onRequestGet({ request, env }) {
  const session = await authenticate(request, env);
  if (session.error) return session.error;

  // 登录成功写入 D1 审计，不进入源码
  await recordAudit(env.DB, {
    action: 'login_success',
    reviewer: session.login,
    result: 'success',
    targetType: 'session',
    targetId: session.login,
  });

  return json({ ok: true, login: session.login });
}
