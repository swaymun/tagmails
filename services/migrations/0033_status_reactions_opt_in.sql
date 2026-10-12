-- Gmail status reactions (👀 received, ✅ done) are opt-in per account, off by
-- default; the owner turns them on from their computer (`tagmails set --reactions on`).
ALTER TABLE accounts ADD COLUMN status_reactions INTEGER NOT NULL DEFAULT 0;
