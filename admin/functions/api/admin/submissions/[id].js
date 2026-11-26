import { authenticate, json, fail } from '../../../_lib/auth.js';
import { approveSubmission, rejectSubmission } from '../../../_lib/store.js';

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

  if (body?.action === 'approve') {
    const result = await approveSubmission(env.DB, {
      id: params.id,
      reviewId: String(body.reviewId || ''),
      companyId: String(body.companyId || ''),
      commitSha: String(body.commitSha || ''),
      reviewer: session.login,
    });
    if (!result.ok) return json({ ok: false, message: result.message || statusMessage(result) }, result.status);
    return json({ ok: true, status: result.status });
  }

  if (body?.action === 'reject') {
    const result = await rejectSubmission(env.DB, {
      id: params.id,
      reason: String(body.reason || ''),
      reviewer: session.login,
    });
    if (!result.ok) return json({ ok: false, message: result.message || statusMessage(result) }, result.status);
    return json({ ok: true, status: result.status });
  }

  return fail(400, '未知操作');
}

function statusMessage(result) {
  return result.code === 'not_found' ? '提交不存在' : '该提交已被处理，请刷新';
}
