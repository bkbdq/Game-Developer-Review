import {
  json,
  fail,
  cleaned,
  originAllowed,
  hashIp,
  rateLimited,
  readJson,
} from '../_lib/public.js';

export async function onRequestPost({ request, env }) {
  if (!originAllowed(request, env)) return fail(403, 'FORBIDDEN', '来源不被允许');
  if (!env.DB) return fail(503, 'UPSTREAM', '服务暂时不可用');

  const body = await readJson(request);
  if (!body) return fail(400, 'INVALID_INPUT', '请求格式不正确');

  const message = cleaned(body.message, 2000);
  const contact = cleaned(body.contact, 120);
  if (!message) return fail(400, 'INVALID_INPUT', '请填写问题说明');

  const ipHash = await hashIp(request.headers.get('CF-Connecting-IP') || '', env.IP_SALT);
  if (await rateLimited(env.DB, 'contact_messages', ipHash)) {
    return fail(429, 'RATE_LIMITED', '提交过于频繁，请稍后再试');
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO contact_messages (id, message, contact, status, created_at, ip_hash)
     VALUES (?, ?, ?, 'received', ?, ?)`,
  ).bind(id, message, contact || null, new Date().toISOString(), ipHash).run();

  return json({ ok: true, id }, 202);
}
