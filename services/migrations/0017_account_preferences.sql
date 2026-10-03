CREATE TABLE account_preferences (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  default_model TEXT NOT NULL CHECK (default_model IN ('gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'claude-sonnet-5-5')),
  default_effort TEXT NOT NULL CHECK (default_effort IN ('low', 'medium', 'high', 'xhigh', 'max', 'ultra')),
  default_speed TEXT NOT NULL CHECK (default_speed IN ('standard', 'fast', 'ultrafast'))
);
