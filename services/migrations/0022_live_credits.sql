-- Credits for launch: a signup bonus and file-transfer charges join top-ups
-- and refunds. Neither has a Stripe checkout, so checkout_id becomes optional.
CREATE TABLE credit_ledger_next (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  checkout_id TEXT REFERENCES billing_checkouts(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents != 0),
  kind TEXT NOT NULL CHECK (kind IN ('test_top_up', 'test_refund', 'test_refund_restored', 'signup_bonus', 'file_transfer')),
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (kind, source_id)
);
INSERT INTO credit_ledger_next SELECT id, account_id, checkout_id, amount_cents, kind, source_id, created_at FROM credit_ledger;
DROP TABLE credit_ledger;
ALTER TABLE credit_ledger_next RENAME TO credit_ledger;
CREATE INDEX credit_ledger_account ON credit_ledger(account_id, created_at);
