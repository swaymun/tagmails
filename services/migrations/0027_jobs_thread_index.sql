-- Intake, steering, claims and the transcript page all look up jobs by thread.
CREATE INDEX IF NOT EXISTS jobs_thread ON jobs(thread_id, created_at);
