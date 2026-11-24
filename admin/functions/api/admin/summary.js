import { authenticate, json, fail } from '../../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  const session = await authenticate(request, env);
  if (session.error) return session.error;
  if (!env.DB) return fail(500, '缺少 D1 绑定 DB');

  const [pending, requests, contacts] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM submissions WHERE status = 'pending'").first(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM requests WHERE status = 'received'").first(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM contact_messages WHERE status = 'received'").first(),
  ]);

  return json({
    ok: true,
    pending: pending?.count || 0,
    requests: requests?.count || 0,
    contacts: contacts?.count || 0,
  });
}
