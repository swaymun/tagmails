import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { handleInbound } from './relay-worker.mjs';
import { bindings } from './bindings-fixture.mjs';

function mail(providerEmailId, from, overrides = {}) {
  return {
    providerEmailId, eventId: `event-${providerEmailId}`, messageId: `<${providerEmailId}@gmail.com>`,
    from, agentAddress: 'agent@wonder.test', to: ['agent@wonder.test'], cc: [], bcc: [], subject: 'Shared work', body: 'Review this.',
    parentIds: [], attachments: [], rawMime: Buffer.from(`From: ${from}\r\nMessage-ID: <${providerEmailId}@gmail.com>\r\n`),
    ...overrides,
  };
}

async function deliver(env, message, options = {}) {
  const request = new Request('https://relay.example/webhooks/resend', { method: 'POST', body: '{}' });
  const response = await handleInbound(request, env, { inspect: async () => message, ...options });
  assert.equal(response.status, 200);
  return response.json();
}

test('one Jev call routes the initial email and replies retain that route', async () => {
  const { env, sqlite } = bindings();
  env.TYPESAFE_API_KEY = 'test-key';
  let calls = 0;
  const fetchModel = async () => {
    calls += 1;
    return Response.json({ answers: { route: { type: 'choice', choice: 'claude',
      probabilities: { claude: 0.96 } } } });
  };
  const first = mail('email-1', 'owner@gmail.com', { body: 'Use Claude to review this.' });
  await deliver(env, first, { fetchModel });
  await deliver(env, mail('email-2', 'owner@gmail.com', {
    parentIds: [first.messageId], body: 'Continue the review.',
  }), { fetchModel });
  assert.equal(calls, 1);
  assert.deepEqual(sqlite.prepare('SELECT model_json FROM jobs ORDER BY rowid').all()
    .map((row) => JSON.parse(row.model_json)), [
    { id: 'claude-sonnet-5-5', effort: 'medium', source: 'classified' },
    { id: 'claude-sonnet-5-5', effort: 'medium', source: 'thread' },
  ]);
});

test('verified ingress stores one durable job, deduplicates, and grants only visible owner recipients', async () => {
  const { env, sqlite, objects } = bindings();
  const first = mail('email-1', 'owner@gmail.com', {
    to: ['agent@wonder.test', 'reviewer@gmail.com'], bcc: ['hidden@gmail.com'],
  });
  assert.deepEqual(await deliver(env, first), { accepted: true, duplicate: false });
  assert.deepEqual(await deliver(env, first), { accepted: true, duplicate: true });
  assert.equal(sqlite.prepare('SELECT count(*) n FROM jobs').get().n, 1);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM messages').get().n, 1);
  assert.deepEqual(sqlite.prepare('SELECT email FROM participants').all().map((row) => row.email), ['reviewer@gmail.com']);
  assert.equal(objects.size, 1);
  assert.deepEqual(objects.get('inbound/account-1/email-1.eml'), first.rawMime);
});

test('only an owner-granted participant can continue the thread and guests cannot add others', async () => {
  const { env, sqlite, objects } = bindings();
  const first = mail('email-1', 'owner@gmail.com', { cc: ['reviewer@gmail.com'] });
  await deliver(env, first);
  assert.deepEqual(await deliver(env, mail('email-2', 'stranger@gmail.com')), { accepted: false });
  assert.deepEqual(await deliver(env, mail('email-3', 'stranger@gmail.com', { parentIds: [first.messageId] })), { accepted: false });
  assert.deepEqual(await deliver(env, mail('email-4', 'reviewer@gmail.com', {
    parentIds: [first.messageId], cc: ['stranger@gmail.com'],
  })), { accepted: true, duplicate: false });
  assert.equal(sqlite.prepare('SELECT count(*) n FROM threads').get().n, 1);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM jobs').get().n, 2);
  assert.deepEqual(sqlite.prepare('SELECT email FROM participants').all().map((row) => row.email), ['reviewer@gmail.com']);
  assert.equal(objects.size, 2);
  sqlite.prepare('UPDATE participants SET revoked_at = CURRENT_TIMESTAMP WHERE email = ?').run('reviewer@gmail.com');
  assert.deepEqual(await deliver(env, mail('email-5', 'reviewer@gmail.com', { parentIds: [first.messageId] })), { accepted: false });
});

test('Gmail reaction mail never creates an agent job', async () => {
  const { env, sqlite } = bindings();
  const first = mail('email-1', 'owner@gmail.com');
  await deliver(env, first);
  assert.deepEqual(await deliver(env, mail('email-2', 'owner@gmail.com', {
    parentIds: [first.messageId], reaction: '👍', reactionTargetId: first.messageId,
  })), { accepted: false, reaction: true });
  assert.equal(sqlite.prepare('SELECT count(*) n FROM jobs').get().n, 1);
});

test('R2 failure leaves no job and a later delivery can be retried', async () => {
  const { env, sqlite } = bindings();
  const originalPut = env.MAIL.put;
  env.MAIL.put = async () => { throw new Error('R2 unavailable'); };
  const message = mail('email-1', 'owner@gmail.com');
  const request = new Request('https://relay.example/webhooks/resend', { method: 'POST', body: '{}' });
  await assert.rejects(handleInbound(request, env, { inspect: async () => message }), /R2 unavailable/);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM jobs').get().n, 0);
  env.MAIL.put = originalPut;
  assert.deepEqual(await deliver(env, message), { accepted: true, duplicate: false });
  assert.equal(sqlite.prepare('SELECT count(*) n FROM jobs').get().n, 1);
});

test('two account addresses route independently and cannot borrow each other\'s threads', async () => {
  const { env, sqlite } = bindings();
  sqlite.prepare('INSERT INTO accounts (id, google_sub, owner_email, agent_email) VALUES (?, ?, ?, ?)')
    .run('account-2', 'google-2', 'second@gmail.com', 'u-second@tagmails.test');
  const first = mail('email-1', 'owner@gmail.com', { agentAddress: 'agent@wonder.test' });
  const second = mail('email-2', 'second@gmail.com', {
    agentAddress: 'u-second@tagmails.test', to: ['u-second@tagmails.test'],
  });
  assert.deepEqual(await deliver(env, first), { accepted: true, duplicate: false });
  assert.deepEqual(await deliver(env, second), { accepted: true, duplicate: false });
  assert.deepEqual(sqlite.prepare('SELECT account_id FROM threads ORDER BY account_id').all()
    .map((row) => row.account_id), ['account-1', 'account-2']);
  assert.deepEqual(await deliver(env, mail('email-3', 'owner@gmail.com', {
    agentAddress: 'u-second@tagmails.test', to: ['u-second@tagmails.test'],
    parentIds: [first.messageId],
  })), { accepted: false });
  assert.equal(sqlite.prepare('SELECT count(*) n FROM jobs').get().n, 2);
});

test('a signed Resend delivery selects the matching account address', async () => {
  const { env, sqlite } = bindings();
  sqlite.prepare('INSERT INTO accounts (id, google_sub, owner_email, agent_email) VALUES (?, ?, ?, ?)')
    .run('account-2', 'google-2', 'second@gmail.com', 'u-second@tagmails.test');
  const secret = `whsec_${Buffer.from('synthetic-signed-inbound-secret').toString('base64')}`;
  env.RESEND_WEBHOOK_SECRET = secret;
  const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const messageId = '<second-turn@gmail.com>';
  const data = { email_id: id, message_id: messageId, from: 'second@gmail.com',
    to: ['u-second@tagmails.test'], cc: [], bcc: [] };
  const rawMime = [
    'From: second@gmail.com', 'To: u-second@tagmails.test',
    'Subject: Check this', `Message-ID: ${messageId}`,
    'Content-Type: text/plain; charset=utf-8', '', 'Review this.',
  ].join('\r\n');
  const webhook = (recipients) => {
    const payload = JSON.stringify({ type: 'email.received', data: { ...data, to: recipients } });
    const eventId = 'msg_account_routing_test';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
      .update(`${eventId}.${timestamp}.${payload}`).digest('base64');
    return new Request('https://relay.test/webhooks/resend', { method: 'POST', body: payload,
      headers: { 'svix-id': eventId, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` } });
  };
  const provider = {
    getReceivedEmail: async () => ({ ...data, id, authentication: { dmarc: 'pass' },
      raw: { download_url: 'https://inbound.resend.com/raw/account-2' } }),
    fetchRaw: async () => new Response(rawMime),
  };
  assert.deepEqual(await (await handleInbound(webhook(data.to), env, provider)).json(),
    { accepted: true, duplicate: false });
  assert.equal(sqlite.prepare('SELECT account_id FROM messages').get().account_id, 'account-2');
  assert.deepEqual(await (await handleInbound(webhook(['agent@wonder.test', 'u-second@tagmails.test']), env, {
    ...provider, getReceivedEmail: async () => { throw new Error('Ambiguous mail must not be fetched'); },
  })).json(), { accepted: false });
});
