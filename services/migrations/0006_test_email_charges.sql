CREATE TABLE test_email_charges (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents = 5),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'settled', 'released')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX test_email_charges_account ON test_email_charges(account_id, state);
