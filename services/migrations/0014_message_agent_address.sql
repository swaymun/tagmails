ALTER TABLE messages ADD COLUMN agent_email TEXT;

UPDATE messages
SET agent_email = (SELECT agent_email FROM accounts WHERE accounts.id = messages.account_id)
WHERE direction = 'inbound';
