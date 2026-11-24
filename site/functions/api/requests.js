import {
  json,
  fail,
  isUuid,
  cleaned,
  originAllowed,
  hashIp,
  rateLimited,
  readJson,
} from '../_lib/public.js';

const TYPES = new Set(['deletion', 'correction']);

export async function onRequestPost({ request, env }) {
  if (!originAllowed(request, env)) return fail(403, 'FORBIDDEN', '来源不被允许');
  if (!env.DB) return fail(503, 'UPSTREAM', '服务暂时不可用');

  const body = await readJson(request);
  if (!body) return fail(400, 'INVALID_INPUT', '请求格式不正确');

  const receipt = cleaned(body.receipt, 64);
  const type = cleaned(body.type, 20);
  const message = cleaned(body.message, 1000);
  if (!isUuid(receipt)) return fail(400, 'INVALID_INPUT', '回执编号格式不正确');
  if (!TYPES.has(type)) return fail(400, 'INVALID_INPUT', '申请类型不正确');
  if (message.length < 1) return fail(400, 'INVALID_INPUT', '请填写申请原因');

  const ipHash = await hashIp(request.headers.get('CF-Connecting-IP') || '', env.IP_SALT);
  if (await rateLimited(env.DB, 'requests', ipHash)) {
    return fail(429, 'RATE_LIMITED', '提交过于频繁，请稍后再试');
  }

  const submission = await env.DB
    .prepare('SELECT id, status, review_id, payload FROM submissions WHERE id = ?')
    .bind(receipt).first();
  if (!submission) return fail(404, 'NOT_FOUND', '未找到该回执');
  if (submission.status !== 'approved' || !submission.review_id) {
    return fail(409, 'NOT_PUBLISHED', '该评价尚未公开发布，暂不能申请删除或更正');
  }

  const duplicate = await env.DB.prepare(
    "SELECT id FROM requests WHERE receipt = ? AND type = ? AND status = 'received' LIMIT 1",
  ).bind(receipt, type).first();
  if (duplicate) return json({ ok: true, id: duplicate.id }, 202);

  let companyId = null;
  try {
    companyId = JSON.parse(submission.payload)?.payload?.companyId || null;
  } catch {
    companyId = null;
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO requests (id, receipt, type, message, status, review_id, company_id, created_at, ip_hash)
     VALUES (?, ?, ?, ?, 'received', ?, ?, ?, ?)`,
  ).bind(id, receipt, type, message, submission.review_id, companyId, new Date().toISOString(), ipHash).run();

  return json({ ok: true, id }, 202);
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return fail(503, 'UPSTREAM', '服务暂时不可用');
  const receipt = new URL(request.url).searchParams.get('receipt') || '';
  if (!isUuid(receipt)) return fail(400, 'INVALID_INPUT', '回执编号格式不正确');

  const { results = [] } = await env.DB.prepare(
    `SELECT id, type, status, created_at, processed_at, result_note
     FROM requests WHERE receipt = ? ORDER BY created_at DESC LIMIT 20`,
  ).bind(receipt).all();

  return json({
    ok: true,
    requests: results.map(row => ({
      id: row.id,
      type: row.type,
      status: row.status,
      createdAt: row.created_at,
      processedAt: row.processed_at,
      resultNote: row.result_note,
    })),
  });
}
