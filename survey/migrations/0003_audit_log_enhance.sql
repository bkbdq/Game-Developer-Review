-- 审计日志扩展：记录结果、对象类型 / ID、附加信息（如 Git commit SHA）
-- 只存在 D1，不进入公开仓库
ALTER TABLE audit_log ADD COLUMN result TEXT NOT NULL DEFAULT 'success';  -- success / denied / failed
ALTER TABLE audit_log ADD COLUMN target_type TEXT;                        -- submission / review / request / contact / session / deploy
ALTER TABLE audit_log ADD COLUMN target_id TEXT;
ALTER TABLE audit_log ADD COLUMN details TEXT;                            -- JSON，如 {"commitSha":"..."}

CREATE INDEX IF NOT EXISTS idx_audit_action_at
  ON audit_log (action, at);

CREATE INDEX IF NOT EXISTS idx_audit_reviewer_at
  ON audit_log (reviewer, at);
