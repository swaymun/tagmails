CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  token_hash TEXT NOT NULL UNIQUE,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE jobs ADD COLUMN device_id TEXT REFERENCES devices(id);
ALTER TABLE jobs ADD COLUMN lease_id TEXT;
ALTER TABLE jobs ADD COLUMN lease_until TEXT;
ALTER TABLE jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN result_key TEXT;
ALTER TABLE jobs ADD COLUMN result_hash TEXT;

CREATE INDEX jobs_device_lease ON jobs(device_id, lease_until);
