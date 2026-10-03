CREATE TABLE delivery_recipients (
  job_id TEXT NOT NULL REFERENCES jobs(id),
  provider_email_id TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('delivered', 'delayed', 'bounced', 'failed', 'suppressed')),
  event_at TEXT NOT NULL,
  event_id TEXT,
  PRIMARY KEY (job_id, provider_email_id, recipient_email)
);
