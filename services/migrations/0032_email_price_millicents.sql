-- Email charges move from whole cents to thousandths of a cent so an email
-- can cost a fraction of a cent (0.25 cents = 250). Top-ups stay in cents.
CREATE TABLE test_email_charges_next (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  amount_millicents INTEGER NOT NULL CHECK (amount_millicents > 0),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'settled', 'released')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO test_email_charges_next (job_id, account_id, amount_millicents, state, created_at, updated_at)
  SELECT job_id, account_id, amount_cents * 1000, state, created_at, updated_at FROM test_email_charges;
DROP TABLE test_email_charges;
ALTER TABLE test_email_charges_next RENAME TO test_email_charges;
CREATE INDEX test_email_charges_account ON test_email_charges(account_id, state);
