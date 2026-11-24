import { authenticate, json, fail } from '../../../_lib/auth.js';
import { handleContact } from '../../../_lib/store.js';

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
  if (body?.action !== 'handle') return fail(400, '未知操作');

  const result = await handleContact(env.DB, {
    id: params.id,
    note: String(body?.note || ''),
    reviewer: session.login,
  });
  if (!result.ok) {
    const message = result.code === 'not_found' ? '消息不存在' : (result.message || '该消息已被处理，请刷新');
    return json({ ok: false, message }, result.status);
  }
  return json({ ok: true, status: result.status });
}
