-- A computer's own default model, effort and speed, set with
-- `tagmails start --model/--effort/--speed`. A default saved on the website
-- (account_preferences) overrides it.
ALTER TABLE devices ADD COLUMN defaults_json TEXT;
