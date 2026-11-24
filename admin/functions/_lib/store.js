const REVIEW_ID = /^rv_[0-9A-Z]+$/;
const COMPANY_ID = /^c_[a-z0-9_-]+$/;

const conflict = status => ({ ok: false, code: 'conflict', status });
const notFound = () => ({ ok: false, code: 'not_found', status: 404 });
const invalid = message => ({ ok: false, code: 'invalid', status: 400, message });

export async function listSubmissions(db, { status = 'pending', limit = 50, offset = 0 } = {}) {
  const [list, total] = await Promise.all([
    db.prepare(
      'SELECT id, payload, status, flags, created_at FROM submissions WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    ).bind(status, limit, offset).all(),
    db.prepare('SELECT COUNT(*) AS count FROM submissions WHERE status = ?').bind(status).first(),
  ]);

  const items = [];
  for (const row of list.results || []) {
    let submission = null;
    try {
      submission = JSON.parse(row.payload);
    } catch {
      continue;
    }
    items.push({
      id: row.id,
      status: row.status,
      createdAt: row.created_at,
      flags: row.flags ? row.flags.split(',') : [],
      submission,
    });
  }

  return { items, total: total?.count || 0 };
}

export async function approveSubmission(db, { id, reviewId, companyId, reviewer }) {
  if (!REVIEW_ID.test(reviewId || '')) return invalid('reviewId 格式不合法');
  if (!COMPANY_ID.test(companyId || '')) return invalid('companyId 格式不合法');

  const row = await db.prepare('SELECT status, review_id FROM submissions WHERE id = ?').bind(id).first();
  if (!row) return notFound();
  if (row.status === 'approved') {
    return row.review_id === reviewId ? { ok: true, status: 'approved' } : conflict(row.status);
  }
  if (row.status !== 'pending') return conflict(row.status);

  const reviewedAt = new Date().toISOString();
  const result = await db.prepare(
    "UPDATE submissions SET status = 'approved', review_id = ?, reviewer = ?, reviewed_at = ? WHERE id = ? AND status = 'pending'",
  ).bind(reviewId, reviewer, reviewedAt, id).run();
  if ((result.meta?.changes || 0) === 0) return conflict('pending');

  await db.prepare(
    "INSERT INTO audit_log (at, action, reviewer, submission_id, review_id, company_id) VALUES (?, 'approve', ?, ?, ?, ?)",
  ).bind(reviewedAt, reviewer, id, reviewId, companyId).run();

  return { ok: true, status: 'approved' };
}

export async function rejectSubmission(db, { id, reason, reviewer }) {
  const text = String(reason || '').trim();
  if (!text) return invalid('拒绝原因不能为空');
  if (text.length > 500) return invalid('拒绝原因不超过 500 字');

  const row = await db.prepare('SELECT status FROM submissions WHERE id = ?').bind(id).first();
  if (!row) return notFound();
  if (row.status === 'rejected') return { ok: true, status: 'rejected' };
  if (row.status !== 'pending') return conflict(row.status);

  const reviewedAt = new Date().toISOString();
  const result = await db.prepare(
    "UPDATE submissions SET status = 'rejected', reject_reason = ?, reviewer = ?, reviewed_at = ? WHERE id = ? AND status = 'pending'",
  ).bind(text, reviewer, reviewedAt, id).run();
  if ((result.meta?.changes || 0) === 0) return conflict('pending');

  await db.prepare(
    "INSERT INTO audit_log (at, action, reviewer, submission_id, reason) VALUES (?, 'reject', ?, ?, ?)",
  ).bind(reviewedAt, reviewer, id, text).run();

  return { ok: true, status: 'rejected' };
}

const requestItem = row => ({
  id: row.id,
  receipt: row.receipt,
  type: row.type,
  status: row.status,
  message: row.message,
  reviewId: row.review_id || '',
  companyId: row.company_id || '',
  createdAt: row.created_at,
  processedAt: row.processed_at || '',
  reviewer: row.reviewer || '',
  resultNote: row.result_note || '',
});

export async function listRequests(db, { status = 'received', type = '', limit = 50, offset = 0 } = {}) {
  const filters = ['status = ?'];
  const binds = [status];
  if (type) {
    filters.push('type = ?');
    binds.push(type);
  }
  const where = filters.join(' AND ');
  const [list, total] = await Promise.all([
    db.prepare(
      `SELECT id, receipt, type, status, message, review_id, company_id, created_at, processed_at, reviewer, result_note
       FROM requests WHERE ${where} ORDER BY created_at ASC LIMIT ? OFFSET ?`,
    ).bind(...binds, limit, offset).all(),
    db.prepare(`SELECT COUNT(*) AS count FROM requests WHERE ${where}`).bind(...binds).first(),
  ]);
  return { items: (list.results || []).map(requestItem), total: total?.count || 0 };
}

export async function processRequest(db, { id, action, note, reviewer, reviewId, companyId }) {
  if (!['process', 'reject'].includes(action)) return invalid('未知操作');
  const row = await db.prepare(
    'SELECT id, receipt, type, status, review_id, company_id FROM requests WHERE id = ?',
  ).bind(id).first();
  if (!row) return notFound();
  if (row.status !== 'received') {
    return row.status === (action === 'reject' ? 'rejected' : 'processed')
      ? { ok: true, status: row.status }
      : conflict(row.status);
  }

  const text = String(note || '').trim().slice(0, 500);
  if (action === 'reject' && !text) return invalid('驳回必须填写说明');

  const status = action === 'reject' ? 'rejected' : 'processed';
  const processedAt = new Date().toISOString();
  const nextReviewId = reviewId || null;
  const nextCompanyId = companyId || null;
  const result = await db.prepare(
    `UPDATE requests SET status = ?, processed_at = ?, reviewer = ?, result_note = ?,
       review_id = COALESCE(?, review_id), company_id = COALESCE(?, company_id)
     WHERE id = ? AND status = 'received'`,
  ).bind(status, processedAt, reviewer, text || null, nextReviewId, nextCompanyId, id).run();
  if ((result.meta?.changes || 0) === 0) return conflict('received');

  const auditAction = action === 'reject'
    ? 'request_rejected'
    : (row.type === 'deletion' ? 'delete' : 'correct');
  await db.prepare(
    `INSERT INTO audit_log (at, action, reviewer, submission_id, review_id, company_id, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    processedAt,
    auditAction,
    reviewer,
    row.receipt,
    nextReviewId || row.review_id || null,
    nextCompanyId || row.company_id || null,
    text || null,
  ).run();

  return { ok: true, status };
}

const contactItem = row => ({
  id: row.id,
  message: row.message,
  contact: row.contact || '',
  status: row.status,
  createdAt: row.created_at,
  handledAt: row.handled_at || '',
  reviewer: row.reviewer || '',
});

export async function listContacts(db, { status = 'received', limit = 50, offset = 0 } = {}) {
  const [list, total] = await Promise.all([
    db.prepare(
      `SELECT id, message, contact, status, created_at, handled_at, reviewer
       FROM contact_messages WHERE status = ? ORDER BY created_at ASC LIMIT ? OFFSET ?`,
    ).bind(status, limit, offset).all(),
    db.prepare('SELECT COUNT(*) AS count FROM contact_messages WHERE status = ?').bind(status).first(),
  ]);
  return { items: (list.results || []).map(contactItem), total: total?.count || 0 };
}

export async function handleContact(db, { id, reviewer, note }) {
  const row = await db.prepare('SELECT status FROM contact_messages WHERE id = ?').bind(id).first();
  if (!row) return notFound();
  if (row.status === 'handled') return { ok: true, status: 'handled' };

  const handledAt = new Date().toISOString();
  const result = await db.prepare(
    "UPDATE contact_messages SET status = 'handled', handled_at = ?, reviewer = ? WHERE id = ? AND status = 'received'",
  ).bind(handledAt, reviewer, id).run();
  if ((result.meta?.changes || 0) === 0) return conflict('received');

  await db.prepare(
    "INSERT INTO audit_log (at, action, reviewer, submission_id, reason) VALUES (?, 'contact_handled', ?, '', ?)",
  ).bind(handledAt, reviewer, String(note || '').trim().slice(0, 500) || null).run();

  return { ok: true, status: 'handled' };
}
