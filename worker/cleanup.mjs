const DAY = 86_400_000;

const iso = time => new Date(time).toISOString();

/**
 * D1 保留期清理：
 * - approved 7 天后脱敏原始 payload
 * - rejected 30 天删除、pending 90 天删除
 * - 30 天后清空 ip_hash 与 payload.meta.ipHash
 * - 申请/联系记录处理完 90 天删除，联系方式 30 天清空
 */
export async function runCleanup(db, now = Date.now()) {
  const steps = [
    [
      `UPDATE submissions SET payload = '{"schemaVersion":1,"redacted":true}', ip_hash = NULL
       WHERE status = 'approved' AND reviewed_at IS NOT NULL AND reviewed_at < ?`,
      iso(now - 7 * DAY),
    ],
    [
      "DELETE FROM submissions WHERE status = 'rejected' AND reviewed_at IS NOT NULL AND reviewed_at < ?",
      iso(now - 30 * DAY),
    ],
    [
      "DELETE FROM submissions WHERE status = 'pending' AND created_at < ?",
      iso(now - 90 * DAY),
    ],
    [
      "UPDATE submissions SET payload = json_remove(payload, '$.meta.ipHash'), ip_hash = NULL\n       WHERE created_at < ? AND ip_hash IS NOT NULL",
      iso(now - 30 * DAY),
    ],
    [
      'UPDATE requests SET ip_hash = NULL WHERE ip_hash IS NOT NULL AND created_at < ?',
      iso(now - 30 * DAY),
    ],
    [
      'UPDATE contact_messages SET ip_hash = NULL WHERE ip_hash IS NOT NULL AND created_at < ?',
      iso(now - 30 * DAY),
    ],
    [
      "DELETE FROM requests WHERE status IN ('processed', 'rejected') AND processed_at IS NOT NULL AND processed_at < ?",
      iso(now - 90 * DAY),
    ],
    [
      "DELETE FROM contact_messages WHERE status = 'handled' AND handled_at IS NOT NULL AND handled_at < ?",
      iso(now - 90 * DAY),
    ],
    [
      'UPDATE contact_messages SET contact = NULL WHERE contact IS NOT NULL AND created_at < ?',
      iso(now - 30 * DAY),
    ],
  ];

  const results = [];
  for (const [sql, value] of steps) {
    const result = await db.prepare(sql).bind(value).run();
    results.push({ sql, value, changes: result.meta?.changes || 0 });
  }
  return results;
}

export default {
  async scheduled(controller, env, ctx) {
    if (!env.DB) throw new Error('缺少 D1 绑定 DB');
    ctx.waitUntil(runCleanup(env.DB).then(results => {
      const total = results.reduce((sum, item) => sum + item.changes, 0);
      console.log(`清理完成：${results.length} 条规则，影响 ${total} 行`);
    }).catch(error => {
      console.error('清理失败', String(error));
    }));
  },
  async fetch() {
    return new Response('gdr-cleanup', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  },
};
