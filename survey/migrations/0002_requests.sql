-- M6：删除/更正申请与联系我们
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  receipt TEXT NOT NULL,
  type TEXT NOT NULL,                       -- deletion / correction
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',  -- received / processed / rejected
  review_id TEXT,
  company_id TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT,
  reviewer TEXT,
  result_note TEXT,
  ip_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_requests_status_created
  ON requests (status, created_at);

CREATE INDEX IF NOT EXISTS idx_requests_receipt
  ON requests (receipt, created_at);

CREATE INDEX IF NOT EXISTS idx_requests_ip_created
  ON requests (ip_hash, created_at);

CREATE TABLE IF NOT EXISTS contact_messages (
  id TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  contact TEXT,
  status TEXT NOT NULL DEFAULT 'received',  -- received / handled
  created_at TEXT NOT NULL,
  handled_at TEXT,
  reviewer TEXT,
  ip_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_contact_status_created
  ON contact_messages (status, created_at);

CREATE INDEX IF NOT EXISTS idx_contact_ip_created
  ON contact_messages (ip_hash, created_at);
