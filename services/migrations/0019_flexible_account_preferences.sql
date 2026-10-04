CREATE TABLE account_preferences_next (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  default_model TEXT NOT NULL,
  default_effort TEXT NOT NULL CHECK (default_effort IN ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra')),
  default_speed TEXT NOT NULL CHECK (default_speed IN ('standard', 'fast', 'ultrafast'))
);
INSERT INTO account_preferences_next SELECT * FROM account_preferences;
DROP TABLE account_preferences;
ALTER TABLE account_preferences_next RENAME TO account_preferences;
