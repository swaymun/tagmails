-- Permissions are now set only on the computer. Clear choices the website
-- saved so a relay that briefly still reads them sends nothing.
UPDATE account_preferences SET codex_access = NULL, claude_permission = NULL;
