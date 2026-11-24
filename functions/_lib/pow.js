const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64urlFromBytes(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesFromB64url(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}

const b64urlFromText = text => b64urlFromBytes(encoder.encode(text));
const textFromB64url = value => decoder.decode(bytesFromB64url(value));

async function sign(secret, text) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(text));
  return b64urlFromBytes(new Uint8Array(signature));
}

/** 服务端签发限时 PoW 挑战。 */
export async function issueChallenge({ secret, difficulty = 3, ttlMs = 10 * 60 * 1000, now = Date.now() }) {
  if (!secret) throw new Error('缺少 POW_SECRET');
  const payload = {
    v: 1,
    ts: now,
    exp: now + ttlMs,
    d: Math.max(1, Math.min(5, Number(difficulty) || 3)),
    n: b64urlFromBytes(crypto.getRandomValues(new Uint8Array(9))),
  };
  const body = b64urlFromText(JSON.stringify(payload));
  return {
    challenge: `v1.${body}.${await sign(secret, body)}`,
    difficulty: payload.d,
    expiresAt: payload.exp,
  };
}

/** 校验签名、版本与过期时间；成功返回 payload。 */
export async function verifyChallenge(token, secret, now = Date.now()) {
  if (!secret || typeof token !== 'string') return { ok: false };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return { ok: false };
  const body = parts[1];
  if (await sign(secret, body) !== parts[2]) return { ok: false };
  let payload = null;
  try {
    payload = JSON.parse(textFromB64url(body));
  } catch {
    return { ok: false };
  }
  if (!payload || payload.v !== 1 || !Number.isFinite(payload.exp) || payload.exp < now) {
    return { ok: false };
  }
  return { ok: true, payload };
}
