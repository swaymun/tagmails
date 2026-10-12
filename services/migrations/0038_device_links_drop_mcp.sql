-- Pairing by link: `tagmails pair` registers its new device token here and
-- shows a short code; the owner types it at <site>/connect after Google
-- sign-in, which adds the computer to their account (services/device-link.mjs).
CREATE TABLE device_links (
  token_hash TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  public_key TEXT,
  account_id TEXT REFERENCES accounts(id),
  expires_at TEXT NOT NULL,
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The MCP server (0034) is gone; the link and skill.md replace it.
ALTER TABLE pairing_codes DROP COLUMN mcp_grant_id;
DROP TABLE mcp_tokens;
DROP TABLE mcp_auth_codes;
DROP TABLE mcp_grants;
DROP TABLE mcp_clients;
