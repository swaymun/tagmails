-- When a request the relay answered itself ("which project?", an unavailable
-- model) has been handed to an agent along with a later turn.
ALTER TABLE jobs ADD COLUMN handed_to_agent_at TEXT;
