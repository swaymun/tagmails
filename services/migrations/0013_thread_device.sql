ALTER TABLE threads ADD COLUMN device_id TEXT REFERENCES devices(id);

UPDATE threads SET device_id = (
  SELECT j.device_id FROM jobs j
  WHERE j.thread_id = threads.id AND j.device_id IS NOT NULL
  ORDER BY j.created_at, j.rowid LIMIT 1
);
