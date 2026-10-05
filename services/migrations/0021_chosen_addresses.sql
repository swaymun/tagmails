-- Owners can choose their agent address (name@tagmails.com). Earlier addresses
-- stay as aliases of the same account, so they keep working and can't be reused.
ALTER TABLE accounts ADD COLUMN address_changed_at TEXT;
