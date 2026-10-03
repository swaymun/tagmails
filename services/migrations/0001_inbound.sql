CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  owner_email TEXT NOT NULL UNIQUE,
  agent_email TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE participants (
  thread_id TEXT NOT NULL REFERENCES threads(id),
  email TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (thread_id, email)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  thread_id TEXT NOT NULL REFERENCES threads(id),
  provider_email_id TEXT,
  message_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sender_email TEXT NOT NULL,
  object_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (account_id, provider_email_id),
  UNIQUE (account_id, message_id)
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX messages_thread_id ON messages(thread_id);
CREATE INDEX jobs_state ON jobs(state, created_at);
