CREATE TABLE billing_checkouts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents = 1000),
  stripe_session_id TEXT UNIQUE,
  stripe_payment_intent TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE credit_ledger (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  checkout_id TEXT NOT NULL REFERENCES billing_checkouts(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents != 0),
  kind TEXT NOT NULL CHECK (kind IN ('test_top_up', 'test_refund', 'test_refund_restored')),
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (kind, source_id)
);

CREATE INDEX credit_ledger_account ON credit_ledger(account_id, created_at);

CREATE TABLE refund_notifications (
  refund_id TEXT PRIMARY KEY,
  payment_intent TEXT NOT NULL,
  next_check_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX refund_notifications_due ON refund_notifications(resolved_at, next_check_at);
