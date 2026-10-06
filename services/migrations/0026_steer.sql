-- A follow-up email sent while an earlier email in its thread is still running
-- can steer that run instead of queuing. The follow-up's job is stored as
-- completed with steer_state 'pending' until the computer confirms delivery;
-- if the run ends first or delivery fails, it is re-queued as an ordinary job.
ALTER TABLE jobs ADD COLUMN steer_of TEXT;
ALTER TABLE jobs ADD COLUMN steer_state TEXT CHECK (steer_state IN ('pending', 'delivered'));
CREATE INDEX jobs_steer_of ON jobs(steer_of) WHERE steer_of IS NOT NULL;
