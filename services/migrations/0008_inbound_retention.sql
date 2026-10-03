ALTER TABLE messages ADD COLUMN raw_deleted_at TEXT;
CREATE INDEX messages_raw_retention ON messages(direction, raw_deleted_at, created_at);
