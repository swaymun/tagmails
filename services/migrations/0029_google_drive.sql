-- Owners can connect Google Drive (drive.file scope) so large run files go
-- straight from their Mac to their own Drive instead of through TagMails storage.
CREATE TABLE drive_connections (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  refresh_token TEXT NOT NULL,
  folder_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE drive_files (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  name TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  web_link TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX drive_files_job ON drive_files(job_id);
