-- A pairing code remembers the sign-in that made it: a site session or an MCP
-- connection. It pairs a computer only while that sign-in is still valid, so
-- a code issued as its owner signed out (or revoked the app) is dead.
ALTER TABLE pairing_codes ADD COLUMN session_hash TEXT;
ALTER TABLE pairing_codes ADD COLUMN mcp_grant_id TEXT;
