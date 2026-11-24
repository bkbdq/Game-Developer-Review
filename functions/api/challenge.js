import { issueChallenge } from '../_lib/pow.js';

const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

export async function onRequestGet({ env }) {
  if (!env.POW_SECRET) {
    return new Response(JSON.stringify({ ok: false, code: 'UPSTREAM' }), { status: 503, headers: HEADERS });
  }
  const data = await issueChallenge({
    secret: env.POW_SECRET,
    difficulty: Number(env.POW_DIFFICULTY || 3),
  });
  return new Response(JSON.stringify({ ok: true, ...data }), { headers: HEADERS });
}
