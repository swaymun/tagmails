-- Set when a computer claims the job saying it routes model requests, folders and mid-run
-- follow-ups itself (0.2.28+); only then is a follow-up offered to that run. Replaced on every claim.
ALTER TABLE jobs ADD COLUMN local_routing INTEGER;
