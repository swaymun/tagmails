-- A reply whose rendering failed for a passing reason waits until retry_after
-- instead of being retried first on every run (which held up every account).
-- checked_at rotates provider lookups for uncertain sends; it used to bump
-- updated_at, which retention reads as the finish time, so content never expired.
ALTER TABLE outbox ADD COLUMN retry_after TEXT;
ALTER TABLE outbox ADD COLUMN checked_at TEXT;
