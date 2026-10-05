// Chosen agent addresses: name@<ADDRESS_DOMAIN>. Every address an account has
// used stays an alias of that account (account_agent_addresses), so old threads
// keep working and nobody else can take over a released name.

export const USERNAME = /^[a-z0-9](?:[a-z0-9]|[._-](?=[a-z0-9])){2,29}$/;
const RESERVED = new Set(['abuse', 'admin', 'administrator', 'agent', 'api', 'billing', 'bot', 'contact', 'daemon',
  'dmarc', 'help', 'hello', 'hostmaster', 'info', 'legal', 'mail', 'mailer-daemon', 'news', 'noreply', 'no-reply',
  'notifications', 'owner', 'postmaster', 'privacy', 'root', 'sales', 'security', 'setup', 'support', 'system',
  'tagmails', 'tagmail', 'team', 'test', 'webmaster', 'www']);
const CHANGE_INTERVAL_MINUTES = 60;

export function addressDomain(env) {
  const domain = String(env.ADDRESS_DOMAIN ?? '').trim().toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : null;
}

export function usernameProblem(value) {
  const name = String(value ?? '').trim().toLowerCase();
  if (!USERNAME.test(name)) return 'Use 3–30 letters or numbers; dots, hyphens and underscores only between them.';
  if (RESERVED.has(name) || RESERVED.has(name.replace(/[._-]/g, ''))) return 'That name is reserved.';
  return null;
}

export async function checkAddress(env, account, value) {
  const domain = addressDomain(env);
  if (!domain) return { available: false, reason: 'Choosing an address is not enabled yet.' };
  const name = String(value ?? '').trim().toLowerCase();
  const problem = usernameProblem(name);
  if (problem) return { available: false, reason: problem };
  const address = `${name}@${domain}`;
  if (address === account.agent_email) return { available: true, address, current: true };
  const taken = await env.DB.prepare('SELECT account_id FROM account_agent_addresses WHERE email = ?').bind(address).first();
  if (taken && taken.account_id !== account.id) return { available: false, address, reason: 'That address is taken.' };
  return { available: true, address };
}

export async function chooseAddress(env, account, value) {
  const check = await checkAddress(env, account, value);
  if (!check.available) return { error: check.reason, status: 400 };
  if (check.current) return { agentEmail: check.address };
  const recent = await env.DB.prepare(`SELECT 1 FROM accounts WHERE id = ? AND address_changed_at IS NOT NULL
    AND address_changed_at > datetime('now', ?)`).bind(account.id, `-${CHANGE_INTERVAL_MINUTES} minutes`).first();
  if (recent) return { error: 'You changed your address recently. Try again in an hour.', status: 429 };
  try {
    // The update trigger records the new address in account_agent_addresses;
    // its primary key makes a concurrent claim of the same name fail here.
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO account_agent_addresses (email, account_id)
        SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM account_agent_addresses WHERE email = ?)`)
        .bind(check.address, account.id, check.address),
      env.DB.prepare(`UPDATE accounts SET agent_email = ?, address_changed_at = CURRENT_TIMESTAMP
        WHERE id = ? AND EXISTS (SELECT 1 FROM account_agent_addresses WHERE email = ? AND account_id = ?)`)
        .bind(check.address, account.id, check.address, account.id),
    ]);
  } catch { return { error: 'That address is taken.', status: 409 }; }
  const saved = await env.DB.prepare('SELECT agent_email FROM accounts WHERE id = ?').bind(account.id).first();
  return saved?.agent_email === check.address ? { agentEmail: check.address }
    : { error: 'That address is taken.', status: 409 };
}

// Mail from an address on the verified domain goes out under its own name.
// Older accounts on the inbound-only test domain still need the provider's
// test sender, which can't carry reactions.
export function testSenderFor(env, agentEmail) {
  const domain = addressDomain(env);
  if (!env.RESEND_TEST_FROM) return null;
  return domain && String(agentEmail ?? '').toLowerCase().endsWith(`@${domain}`) ? null : env.RESEND_TEST_FROM;
}
