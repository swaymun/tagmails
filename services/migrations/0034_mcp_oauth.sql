-- OAuth for the MCP endpoint (/mcp). Clients register themselves (RFC 7591);
-- a grant is one client's access to one account, and revoking it ends every
-- token issued under it. Codes and tokens are stored only as SHA-256 hashes.
CREATE TABLE mcp_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris_json TEXT NOT NULL,
  -- Set when someone first signs in through this client; unused registrations are pruned.
  authorized_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE mcp_auth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES mcp_clients(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  -- The grant this code was exchanged for, revoked if the code is replayed.
  grant_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE mcp_grants (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES mcp_clients(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  scope TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX mcp_grants_account ON mcp_grants(account_id, revoked_at);

CREATE TABLE mcp_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES mcp_grants(id),
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX mcp_tokens_grant ON mcp_tokens(grant_id);
CREATE INDEX mcp_tokens_expiry ON mcp_tokens(expires_at);
