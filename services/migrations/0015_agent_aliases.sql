CREATE TABLE account_agent_addresses (
  email TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id)
);

INSERT INTO account_agent_addresses (email, account_id)
SELECT agent_email, id FROM accounts;

CREATE TRIGGER account_agent_address_insert AFTER INSERT ON accounts
BEGIN
  INSERT INTO account_agent_addresses (email, account_id)
  VALUES (NEW.agent_email, NEW.id);
END;

CREATE TRIGGER account_agent_address_update AFTER UPDATE OF agent_email ON accounts
WHEN NEW.agent_email != OLD.agent_email
BEGIN
  INSERT INTO account_agent_addresses (email, account_id)
  SELECT NEW.agent_email, NEW.id
  WHERE NOT EXISTS (SELECT 1 FROM account_agent_addresses
    WHERE email = NEW.agent_email AND account_id = NEW.id);
END;
