import { authenticate, json, fail, readInt } from '../../../_lib/auth.js';
import { listRequests } from '../../../_lib/store.js';

export async function onRequestGet({ request, env }) {
  const session = await authenticate(request, env);
  if (session.error) return session.error;
  if (!env.DB) return fail(500, '缺少 D1 绑定 DB');

  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'received';
  const type = url.searchParams.get('type') || '';
  const limit = readInt(url.searchParams.get('limit'), 50, 1, 200);
  const offset = readInt(url.searchParams.get('offset'), 0, 0, 100000);

  if (!['received', 'processed', 'rejected'].includes(status)) return fail(400, '状态不合法');
  if (type && !['deletion', 'correction'].includes(type)) return fail(400, '申请类型不合法');

  const result = await listRequests(env.DB, { status, type, limit, offset });
  return json({ ok: true, ...result });
}
