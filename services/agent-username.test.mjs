import assert from 'node:assert/strict';
import test from 'node:test';
import { bindings } from './bindings-fixture.mjs';
import { checkAddress, chooseAddress, testSenderFor, usernameProblem } from './agent-username.mjs';

const account = (sqlite, id = 'account-1') => sqlite.prepare('SELECT id, agent_email FROM accounts WHERE id = ?').get(id);

test('usernames are short, plain and not reserved', () => {
  for (const name of ['saimun', 'sai.mun', 'build-bot2', 'a_b']) assert.equal(usernameProblem(name), null, name);
  for (const name of ['ab', 'x'.repeat(31), '.lead', 'trail-', 'a..b', 'has space', 'émile', 'admin', 'post-master', 'TagMails'])
    assert.ok(usernameProblem(name), name);
});

test('an owner picks an address; the old one stays theirs and keeps routing', async () => {
  const { env, sqlite } = bindings();
  env.ADDRESS_DOMAIN = 'tagmails.com';
  const before = account(sqlite).agent_email;
  assert.deepEqual(await checkAddress(env, account(sqlite), 'Saimun'), { available: true, address: 'saimun@tagmails.com' });
  assert.deepEqual(await chooseAddress(env, account(sqlite), 'Saimun'), { agentEmail: 'saimun@tagmails.com' });
  assert.equal(account(sqlite).agent_email, 'saimun@tagmails.com');
  const aliases = sqlite.prepare('SELECT email FROM account_agent_addresses WHERE account_id = ? ORDER BY email').all('account-1').map((r) => r.email);
  assert.deepEqual(aliases, [before, 'saimun@tagmails.com'].sort());
  // Choosing the current address again is a no-op, and changes are rate limited.
  assert.deepEqual(await chooseAddress(env, account(sqlite), 'saimun'), { agentEmail: 'saimun@tagmails.com' });
  assert.equal((await chooseAddress(env, account(sqlite), 'other')).status, 429);
});

test('another account cannot take a used or released address', async () => {
  const { env, sqlite } = bindings();
  env.ADDRESS_DOMAIN = 'tagmails.com';
  sqlite.prepare('INSERT INTO accounts (id, google_sub, owner_email, agent_email) VALUES (?, ?, ?, ?)')
    .run('account-2', 'sub-2', 'second@gmail.com', 'u-second@wonder.test');
  await chooseAddress(env, account(sqlite), 'shared');
  const second = account(sqlite, 'account-2');
  assert.deepEqual(await checkAddress(env, second, 'shared'), { available: false, address: 'shared@tagmails.com', reason: 'That address is taken.' });
  assert.equal((await chooseAddress(env, second, 'shared')).status, 400);
  assert.equal(account(sqlite, 'account-2').agent_email, 'u-second@wonder.test');
});

test('choosing is off until an address domain is configured', async () => {
  const { env, sqlite } = bindings();
  assert.equal((await checkAddress(env, account(sqlite), 'saimun')).available, false);
});

test('a chosen address on the verified domain sends as itself; older addresses keep the test sender', () => {
  const env = { ADDRESS_DOMAIN: 'tagmails.com', RESEND_TEST_FROM: 'onboarding@resend.dev' };
  assert.equal(testSenderFor(env, 'saimun@tagmails.com'), null);
  assert.equal(testSenderFor(env, 'u-123@abc.resend.app'), 'onboarding@resend.dev');
  assert.equal(testSenderFor({ ADDRESS_DOMAIN: 'tagmails.com' }, 'u-123@abc.resend.app'), null);
});
