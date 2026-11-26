const DETAILS_LIMIT = 4000;

/**
 * 写入 D1 audit_log。审计失败不阻塞主流程，只输出到运行日志。
 * 注意：不要在这里写入 PAT、评价正文、联系方式等敏感内容。
 */
export async function recordAudit(db, {
  at = new Date().toISOString(),
  action,
  reviewer = '',
  result = 'success',
  targetType = null,
  targetId = null,
  submissionId = '',
  reviewId = null,
  companyId = null,
  reason = null,
  details = null,
} = {}) {
  if (!db || !action) return false;

  let extra = null;
  if (details) {
    try {
      extra = JSON.stringify(details).slice(0, DETAILS_LIMIT);
    } catch {
      extra = null;
    }
  }

  try {
    await db.prepare(
      `INSERT INTO audit_log
         (at, action, reviewer, submission_id, review_id, company_id, reason, result, target_type, target_id, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      at,
      action,
      reviewer || '',
      submissionId || '',
      reviewId || null,
      companyId || null,
      reason == null ? null : String(reason).slice(0, 500),
      result,
      targetType || null,
      targetId ? String(targetId).slice(0, 200) : null,
      extra,
    ).run();
    return true;
  } catch (error) {
    console.error('audit_log 写入失败', action, String(error));
    return false;
  }
}
