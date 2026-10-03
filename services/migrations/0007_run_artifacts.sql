CREATE TABLE run_artifacts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  lease_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 24000000),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL DEFAULT (datetime('now', '+7 days'))
);

CREATE INDEX run_artifacts_job ON run_artifacts(job_id, expires_at);
CREATE INDEX run_artifacts_expiry ON run_artifacts(expires_at);
