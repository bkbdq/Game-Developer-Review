import { authenticate, json, fail } from '../../../_lib/auth.js';
import { processRequest } from '../../../_lib/store.js';

export async function onRequestPost({ request, env, params }) {
  const session = await authenticate(request, env);
  if (session.error) return session.error;
  if (!env.DB) return fail(500, '缺少 D1 绑定 DB');

  let body = null;
  try {
    body = await request.json();
  } catch {
    return fail(400, '请求体不是合法 JSON');
  }

  const result = await processRequest(env.DB, {
    id: params.id,
    action: String(body?.action || ''),
    note: String(body?.note || ''),
    reviewId: String(body?.reviewId || ''),
    companyId: String(body?.companyId || ''),
    reviewer: session.login,
  });

  if (!result.ok) {
    const message = result.code === 'not_found' ? '申请不存在' : (result.message || '该申请已被处理，请刷新');
    return json({ ok: false, message }, result.status);
  }
  return json({ ok: true, status: result.status });
}
