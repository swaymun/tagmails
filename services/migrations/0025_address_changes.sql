-- How many times an account has chosen a new agent address (limit 3).
-- The address picked at signup does not count.
ALTER TABLE accounts ADD COLUMN address_changes INTEGER NOT NULL DEFAULT 0;

-- Website defaults become optional per field: the model can be handed back to
-- the computer while a permission choice stays. Permissions apply only up to
-- the limit the computer was started with (devices.limits_json).
CREATE TABLE account_preferences_next (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  default_model TEXT,
  default_effort TEXT CHECK (default_effort IN ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra')),
  default_speed TEXT CHECK (default_speed IN ('standard', 'fast', 'ultrafast')),
  codex_access TEXT CHECK (codex_access IN ('read', 'write', 'full')),
  claude_permission TEXT CHECK (claude_permission IN ('manual', 'acceptEdits', 'auto', 'bypassPermissions'))
);
INSERT INTO account_preferences_next (account_id, default_model, default_effort, default_speed)
  SELECT account_id, default_model, default_effort, default_speed FROM account_preferences;
DROP TABLE account_preferences;
ALTER TABLE account_preferences_next RENAME TO account_preferences;

ALTER TABLE devices ADD COLUMN limits_json TEXT;
