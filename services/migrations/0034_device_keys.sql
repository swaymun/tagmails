-- Content sealed to a paired computer's key (agent/device-seal.mjs).
-- A device's X25519 public key (base64url) and its short id; NULL for daemons
-- older than 0.2.24, whose jobs keep the relay-key sealing.
ALTER TABLE devices ADD COLUMN public_key TEXT;
ALTER TABLE devices ADD COLUMN key_id TEXT;
ALTER TABLE devices ADD COLUMN key_registered_at TEXT;
-- Set when this message's content is sealed to that device key; only the
-- device holding it can claim the job.
ALTER TABLE messages ADD COLUMN seal_key_id TEXT;
-- Reply threading for sealed mail ({ to, cc, parentIds }); addresses and
-- Message-IDs only, since the relay can no longer read the MIME.
ALTER TABLE messages ADD COLUMN headers_json TEXT;
-- What the site shows for a sealed result: { state, runtime, session }.
ALTER TABLE jobs ADD COLUMN result_meta_json TEXT;
CREATE INDEX IF NOT EXISTS devices_key_id ON devices (key_id);
