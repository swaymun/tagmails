CREATE TABLE status_reactions (
  job_id TEXT NOT NULL REFERENCES jobs(id),
  status TEXT NOT NULL CHECK (status IN ('received', 'working', 'completed', 'failed')),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'sending', 'uncertain', 'accepted', 'blocked')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (job_id, status)
);

CREATE INDEX status_reactions_state ON status_reactions(state, updated_at);
