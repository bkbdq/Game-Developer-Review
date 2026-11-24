const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCAL_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/;
const DEFAULT_ORIGINS = [
  'https://goodcorp.games',
  'https://dev.goodcorp.games',
  'https://github.goodcorp.games',
];

export const isUuid = value => UUID.test(String(value || ''));

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export function fail(status, code, message) {
  return json({ ok: false, code, message }, status);
}

export function cleaned(value, max) {
  return String(value || '').replace(/\r\n?/g, '\n').trim().slice(0, max);
}

export function originAllowed(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  if (LOCAL_ORIGIN.test(origin)) return true;
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',').map(item => item.trim()).filter(Boolean);
  return (allowed.length ? allowed : DEFAULT_ORIGINS).includes(origin);
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashIp(ip, salt) {
  if (!ip || !salt) return null;
  return (await sha256Hex(`${salt}:${ip}`)).slice(0, 16);
}

/** 同一 IP 的宽松限流；没有 ipHash 时直接放行。 */
export async function rateLimited(db, table, ipHash, { minute = 5, day = 20 } = {}) {
  if (!ipHash) return false;
  const now = Date.now();
  const [short, long] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ip_hash = ? AND created_at >= ?`)
      .bind(ipHash, new Date(now - 60_000).toISOString()).first(),
    db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ip_hash = ? AND created_at >= ?`)
      .bind(ipHash, new Date(now - 86_400_000).toISOString()).first(),
  ]);
  return (short?.count || 0) >= minute || (long?.count || 0) >= day;
}

export async function readJson(request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    return body;
  } catch {
    return null;
  }
}
