import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { bindings } from './bindings-fixture.mjs';
import { handleInbound } from './relay-worker.mjs';
import { handleDeviceRequest } from './device-jobs.mjs';
import { reservePendingTestEmails } from './email-charges.mjs';
import { DevicePush } from './device-push.mjs';

function pushBinding() {
  const calls = [];
  return {
    calls,
    idFromName: (name) => ({ name }),
    get: (id) => ({
      fetch: async (url, init = {}) => {
        calls.push({ account: id.name, url, method: init.method ?? 'GET', headers: new Headers(init.headers) });
        return new Response(null, { status: 204 });
      },
    }),
  };
}

function device(sqlite) {
  const token = `tm_dev_${'B'.repeat(43)}`;
  sqlite.prepare('INSERT INTO devices (id, account_id, token_hash) VALUES (?, ?, ?)')
    .run('device-push', 'account-1', createHash('sha256').update(token).digest('hex'));
  return token;
}

async function deliver(env, id, body = 'Check this.') {
  const messageId = `<${id}@gmail.com>`;
  const rawMime = Buffer.from([
    'From: owner@gmail.com', 'To: agent@wonder.test', 'Subject: Push', `Message-ID: ${messageId}`,
    'Content-Type: text/plain; charset=utf-8', '', body,
  ].join('\r\n'));
  const mail = { providerEmailId: id, messageId, from: 'owner@gmail.com', agentAddress: 'agent@wonder.test',
    to: ['agent@wonder.test'], cc: [], bcc: [], subject: 'Push', body, parentIds: [], rawMime };
  const response = await handleInbound(new Request('https://relay.test/webhooks/resend', { method: 'POST', body: '{}' }),
    env, { inspect: async () => mail });
  return response.json();
}

test('accepted mail wakes the account computers once; relay-answered mail does not', async () => {
  const { env, sqlite } = bindings();
  env.DEVICE_PUSH = pushBinding();
  assert.equal((await deliver(env, 'push-1')).accepted, true);
  assert.deepEqual(env.DEVICE_PUSH.calls.map(({ account, url, method }) => ({ account, url, method })),
    [{ account: 'account-1', url: 'https://device-push/notify', method: 'POST' }]);
  await deliver(env, 'push-1');
  assert.equal(env.DEVICE_PUSH.calls.length, 1, 'a duplicate delivery adds no work');
  await deliver(env, 'push-2', 'Model: no-such-model-xyz\nDo it.');
  assert.ok(sqlite.prepare("SELECT json_extract(model_json, '$.error') error FROM jobs ORDER BY rowid DESC").get().error);
  assert.equal(env.DEVICE_PUSH.calls.length, 1, 'the relay answers this one itself');
});

test('mail without a push binding is still accepted', async () => {
  const { env } = bindings();
  assert.deepEqual(await deliver(env, 'push-plain'), { accepted: true, duplicate: false });
});

test('credit reservation wakes computers only when a job became claimable', async () => {
  const { env, sqlite } = bindings();
  Object.assign(env, { BILLING_TEST_MODE: 'true', STRIPE_SECRET_KEY: 'sk_test_local', STRIPE_WEBHOOK_SECRET: 'whsec_local' });
  env.DEVICE_PUSH = pushBinding();
  assert.equal((await deliver(env, 'unfunded')).awaitingCredits, true);
  assert.equal(env.DEVICE_PUSH.calls.length, 0);
  sqlite.prepare('INSERT INTO billing_checkouts (id, account_id, amount_cents) VALUES (?, ?, 1000)').run('checkout-push', 'account-1');
  sqlite.prepare(`INSERT INTO credit_ledger (id, account_id, checkout_id, amount_cents, kind, source_id)
    VALUES ('ledger-push', 'account-1', 'checkout-push', 1000, 'test_top_up', 'topup-push')`).run();
  assert.equal(await reservePendingTestEmails(env, 'account-1'), 1);
  assert.equal(env.DEVICE_PUSH.calls.length, 1);
  assert.equal(await reservePendingTestEmails(env, 'account-1'), 0);
  assert.equal(env.DEVICE_PUSH.calls.length, 1);
});

test('the push route authenticates the device and hands the upgrade to its account object', async () => {
  const { env, sqlite } = bindings();
  const token = device(sqlite);
  const open = (headers) => handleDeviceRequest(new Request('https://relay.test/api/device/push', { headers }), env);
  assert.equal((await open({ Authorization: `Bearer ${token}`, Upgrade: 'websocket' })).status, 404, 'no binding');
  env.DEVICE_PUSH = pushBinding();
  assert.equal((await open({ Upgrade: 'websocket' })).status, 401);
  assert.equal((await open({ Authorization: `Bearer tm_dev_${'C'.repeat(43)}`, Upgrade: 'websocket' })).status, 401);
  assert.equal((await open({ Authorization: `Bearer ${token}` })).status, 426);
  assert.equal(env.DEVICE_PUSH.calls.length, 0);
  await open({ Authorization: `Bearer ${token}`, Upgrade: 'websocket', 'Sec-WebSocket-Key': 'abc', 'Sec-WebSocket-Version': '13' });
  const [call] = env.DEVICE_PUSH.calls;
  assert.equal(call.account, 'account-1');
  assert.equal(call.url, 'https://device-push/connect');
  assert.equal(call.headers.get('x-tagmails-device'), 'device-push');
  assert.equal(call.headers.get('sec-websocket-key'), 'abc');
  assert.equal(call.headers.get('authorization'), null, 'the device token stays in the Worker');
});

test('the account object sends a notice to every open socket', async () => {
  const sent = [];
  const sockets = [{ send: (value) => sent.push(['a', value]) },
    { send: () => { throw new Error('closing'); } }, { send: (value) => sent.push(['b', value]) }];
  const push = new DevicePush({ getWebSockets: () => sockets });
  const response = await push.fetch(new Request('https://device-push/notify', { method: 'POST' }));
  assert.equal(response.status, 204);
  assert.deepEqual(sent, [['a', '{"type":"jobs"}'], ['b', '{"type":"jobs"}']]);
  assert.equal((await push.fetch(new Request('https://device-push/connect'))).status, 404);
});
