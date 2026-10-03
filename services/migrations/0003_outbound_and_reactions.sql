CREATE TABLE outbox (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'blocked', 'sending', 'uncertain', 'accepted', 'sent')),
  payload_json TEXT,
  provider_email_id TEXT UNIQUE,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX outbox_state ON outbox(state, updated_at);

CREATE TABLE reactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  target_message_id TEXT NOT NULL REFERENCES messages(id),
  provider_email_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender_email TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (account_id, provider_email_id),
  UNIQUE (account_id, message_id)
);
