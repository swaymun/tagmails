CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX sessions_account ON sessions(account_id, expires_at);

CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX pairing_codes_account ON pairing_codes(account_id, expires_at);

ALTER TABLE devices ADD COLUMN name TEXT NOT NULL DEFAULT 'Mac';
