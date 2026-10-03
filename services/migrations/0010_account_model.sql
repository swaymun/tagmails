ALTER TABLE accounts ADD COLUMN default_model TEXT NOT NULL DEFAULT 'gpt-6.1-sol'
  CHECK (default_model IN ('gpt-6.1-sol', 'claude-sonnet-5-5'));

ALTER TABLE jobs ADD COLUMN model_json TEXT;
