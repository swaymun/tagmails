-- Streamed run files can be up to 95 MB; the original CHECK capped them at 24 MB.
-- SQLite can't alter a CHECK, so rebuild the table with the same columns.
CREATE TABLE run_artifacts_next (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  lease_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 95000000),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL DEFAULT (datetime('now', '+7 days')),
  sha256 TEXT
);

INSERT INTO run_artifacts_next (id, account_id, job_id, lease_id, object_key, name, mime_type, byte_size, created_at, expires_at, sha256)
  SELECT id, account_id, job_id, lease_id, object_key, name, mime_type, byte_size, created_at, expires_at, sha256 FROM run_artifacts;

DROP TABLE run_artifacts;
ALTER TABLE run_artifacts_next RENAME TO run_artifacts;
CREATE INDEX run_artifacts_job ON run_artifacts(job_id, expires_at);
CREATE INDEX run_artifacts_expiry ON run_artifacts(expires_at);
