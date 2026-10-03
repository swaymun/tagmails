import assert from 'node:assert/strict';
import test from 'node:test';
import { bindings } from './bindings-fixture.mjs';
import { deleteSettledInboundMime } from './inbound-retention.mjs';
import { handleInbound } from './relay-worker.mjs';

test('seven-day cleanup removes settled MIME, retries failed deletes, and preserves reply threading', async () => {
  const { env, sqlite, objects } = bindings();
  sqlite.prepare("INSERT INTO threads (id, account_id, subject) VALUES ('thread-old', 'account-1', 'Old work')").run();
  for (const [id, state, outbox] of [
    ['sent', 'completed', 'sent'], ['pending', 'completed', 'accepted'],
    ['running', 'running', null], ['blocked', 'completed', 'blocked'],
  ]) {
    sqlite.prepare(`INSERT INTO messages
      (id, account_id, thread_id, provider_email_id, message_id, direction, sender_email, object_key, created_at)
      VALUES (?, 'account-1', 'thread-old', ?, ?, 'inbound', 'owner@gmail.com', ?, datetime('now', '-8 days'))`)
      .run(id, `provider-${id}`, `<${id}@gmail.com>`, `inbound/${id}.eml`);
    sqlite.prepare('INSERT INTO jobs (id, thread_id, message_id, state) VALUES (?, ?, ?, ?)')
      .run(`job-${id}`, 'thread-old', id, state);
    if (outbox) sqlite.prepare('INSERT INTO outbox (job_id, state) VALUES (?, ?)').run(`job-${id}`, outbox);
    await env.MAIL.put(`inbound/${id}.eml`, `message-${id}`);
  }
  const remove = env.MAIL.delete;
  let failOnce = true;
  env.MAIL.delete = async (key) => {
    if (key === 'inbound/blocked.eml' && failOnce) { failOnce = false; throw new Error('Temporary R2 failure'); }
    return remove(key);
  };
  const originalError = console.error;
  console.error = () => {};
  try { await deleteSettledInboundMime(env); }
  finally { console.error = originalError; }
  assert.equal(objects.has('inbound/sent.eml'), false);
  assert.equal(objects.has('inbound/blocked.eml'), true);
  assert.equal(sqlite.prepare('SELECT raw_deleted_at FROM messages WHERE id = ?').get('sent').raw_deleted_at !== null, true);
  assert.equal(sqlite.prepare('SELECT raw_deleted_at FROM messages WHERE id = ?').get('blocked').raw_deleted_at, null);
  assert.equal(objects.has('inbound/pending.eml'), true);
  assert.equal(objects.has('inbound/running.eml'), true);
  await deleteSettledInboundMime(env);
  assert.equal(objects.has('inbound/blocked.eml'), false);

  const reply = await handleInbound(new Request('https://relay.test/webhooks/resend', {
    method: 'POST', body: '{}',
  }), env, { inspect: async () => ({
    providerEmailId: 'new-reply', messageId: '<reply@gmail.com>', from: 'owner@gmail.com',
    agentAddress: 'agent@wonder.test', to: ['agent@wonder.test'], cc: [], bcc: [],
    subject: 'Re: Old work', body: 'Please continue.', parentIds: ['<sent@gmail.com>'],
    rawMime: Buffer.from('new message'),
  }) });
  assert.equal(reply.status, 200);
  assert.equal(sqlite.prepare('SELECT thread_id FROM messages WHERE provider_email_id = ?').get('new-reply').thread_id, 'thread-old');
});
