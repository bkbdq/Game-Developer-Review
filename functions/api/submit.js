import {
  LIMITS,
  parseSubmissionBody,
  normalize,
  validate,
  verifyPow,
  hashIp,
  dedupeHash,
  uaFamily,
  isUuid,
} from '../_lib/core.js';
import { verifyChallenge } from '../_lib/pow.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

const json = (body, status) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function page(title, content, status) {
  return new Response(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">` +
    `<title>${escapeHtml(title)}</title><style>body{font:16px/1.7 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1.25rem;color:#1b1b1b}` +
    `a{color:#0a5}code{background:#f2f2f2;padding:.2rem .4rem;border-radius:4px}</style></head>` +
    `<body>${content}</body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
  );
}

const errorText = {
  INVALID_INPUT: '提交内容不完整或格式不正确。',
  POW_FAILED: '校验未通过，请刷新页面后重试。',
  RATE_LIMITED: '提交过于频繁，请稍后再试。',
  DUPLICATE: '同类内容近期已提交过。',
  FORBIDDEN: '来源不被允许。',
  UPSTREAM: '服务暂时不可用，请稍后再试。',
};

export async function onRequestPost({ request, env }) {
  const contentType = request.headers.get('content-type') || '';
  const wantsJson = contentType.includes('application/json') ||
    (request.headers.get('accept') || '').includes('application/json');

  const fail = (code, status) => wantsJson
    ? json({ ok: false, code }, status)
    : page('提交未完成', `<h1>提交未完成</h1><p>${escapeHtml(errorText[code] || '未知错误')}</p><p><a href="/">返回重试</a></p>`, status);

  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (origin && allowed.length && !allowed.includes(origin)) return fail('FORBIDDEN', 403);

  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > LIMITS.bodyBytes) return fail('INVALID_INPUT', 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > LIMITS.bodyBytes) return fail('INVALID_INPUT', 413);

  const parsed = parseSubmissionBody(text, contentType);
  if (parsed.error) return fail(parsed.error, 400);

  // 无 JS 的原生表单无法在客户端生成回执号，由服务端补一个
  if (!wantsJson && !isUuid(parsed.data.submissionId)) {
    parsed.data.submissionId = crypto.randomUUID();
  }

  const input = normalize(parsed.data);
  const result = validate(input);
  if (!result.ok) return fail('INVALID_INPUT', 400);

  if (input.js) {
    let difficulty = Number(env.POW_DIFFICULTY || 3);
    if (env.POW_SECRET) {
      const challenge = await verifyChallenge(input.challenge, env.POW_SECRET);
      if (!challenge.ok) return fail('POW_FAILED', 422);
      difficulty = challenge.payload.d;
    }
    if (!(await verifyPow(input.challenge, input.nonce, difficulty))) return fail('POW_FAILED', 422);
  }

  if (!env.DB) return fail('UPSTREAM', 503);

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ipHash = ip && env.IP_SALT ? await hashIp(ip, env.IP_SALT) : null;
  const now = Date.now();
  const minuteAgo = new Date(now - 60_000).toISOString();
  const dayAgo = new Date(now - 86_400_000).toISOString();

  if (ipHash) {
    const [minute, day] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) AS count FROM submissions WHERE ip_hash = ? AND created_at >= ?')
        .bind(ipHash, minuteAgo).first(),
      env.DB.prepare('SELECT COUNT(*) AS count FROM submissions WHERE ip_hash = ? AND created_at >= ?')
        .bind(ipHash, dayAgo).first(),
    ]);
    if ((minute?.count || 0) >= 5 || (day?.count || 0) >= 100) return fail('RATE_LIMITED', 429);
  }

  const fingerprint = await dedupeHash(input);
  const existing = await env.DB
    .prepare('SELECT id FROM submissions WHERE dedupe_hash = ? AND created_at >= ? LIMIT 1')
    .bind(fingerprint, dayAgo).first();
  if (existing && existing.id !== input.submissionId) return fail('DUPLICATE', 409);

  const submittedAt = new Date().toISOString();
  const submission = {
    schemaVersion: 1,
    submissionId: input.submissionId,
    submittedAt,
    formVersion: '1.0',
    payload: {
      company: input.company,
      ...(input.companyId ? { companyId: input.companyId } : {}),
      project: input.project || undefined,
      ...(input.projectHidden ? { projectHidden: true } : {}),
      score: input.score,
      comment: input.comment,
      wish: input.wish || undefined,
      profile: Object.keys(input.profile).length ? input.profile : undefined,
      consent: input.consent,
    },
    meta: {
      uaFamily: uaFamily(request.headers.get('user-agent') || ''),
      country: request.cf?.country || 'unknown',
      pow: input.js ? 'pass' : 'no_js',
      flags: result.flags,
      ...(ipHash ? { ipHash } : {}),
    },
  };

  await env.DB.prepare(
    `INSERT INTO submissions (id, payload, status, flags, ip_hash, dedupe_hash, created_at)
     VALUES (?, ?, 'pending', ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).bind(
    input.submissionId,
    JSON.stringify(submission),
    result.flags.join(','),
    ipHash,
    fingerprint,
    submittedAt,
  ).run();

  if (wantsJson) return json({ ok: true, receipt: input.submissionId }, 202);

  return page(
    '提交成功',
    `<h1>提交成功</h1><p>回执编号：<code>${escapeHtml(input.submissionId)}</code></p>` +
    `<p>内容将在人工审核后展示。请保存回执编号，便于后续查询或删除。</p><p><a href="/">再提交一条</a></p>`,
    202,
  );
}

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: { Allow: 'POST, OPTIONS' } });
}
