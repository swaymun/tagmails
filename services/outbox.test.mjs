import assert from 'node:assert/strict';
import test from 'node:test';
import { bindings } from './bindings-fixture.mjs';
import { sendNextOutbox } from './outbox.mjs';
import { handleInbound } from './relay-worker.mjs';

function queuedTurn({ env, sqlite }, { number, from, to, cc = [], references = [] }) {
  const threadId = 'thread-1';
  const id = `inbound-${number}`;
  const messageId = `<inbound-${number}@gmail.com>`;
  const raw = [
    `From: ${from}`, `To: ${to.join(', ')}`,
    ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    'Subject: Shared work', `Message-ID: ${messageId}`,
    ...(references.length ? [`References: ${references.join(' ')}`] : []),
    'Content-Type: text/plain; charset=utf-8', '', 'Please review this.',
  ].join('\r\n');
  sqlite.prepare('INSERT OR IGNORE INTO threads (id, account_id, subject) VALUES (?, ?, ?)')
    .run(threadId, 'account-1', 'Shared work');
  sqlite.prepare(`INSERT INTO messages
    (id, account_id, thread_id, provider_email_id, message_id, direction, sender_email, object_key)
    VALUES (?, ?, ?, ?, ?, 'inbound', ?, ?)`).run(id, 'account-1', threadId, `provider-${number}`, messageId, from, `inbound/${number}.eml`);
  sqlite.prepare(`INSERT INTO jobs (id, thread_id, message_id, state, result_key)
    VALUES (?, ?, ?, 'completed', ?)`).run(`job-${number}`, threadId, id, `results/${number}.json`);
  sqlite.prepare('INSERT INTO outbox (job_id) VALUES (?)').run(`job-${number}`);
  return Promise.all([
    env.MAIL.put(`inbound/${number}.eml`, raw),
    env.MAIL.put(`results/${number}.json`, JSON.stringify({ state: 'completed', summary: `Turn ${number} finished.` })),
  ]);
}

async function reaction(env, { providerEmailId, from, targetId }) {
  const message = {
    providerEmailId, messageId: `<${providerEmailId}@gmail.com>`, from,
    reaction: '👍', reactionTargetId: targetId,
  };
  const response = await handleInbound(new Request('https://relay.test/webhooks/resend', {
    method: 'POST', body: '{}',
  }), env, { inspect: async () => message });
  return response.json();
}

test('two sent turns preserve threading and only visible recipients may react', async () => {
  const fixture = bindings();
  const { env, sqlite } = fixture;
  await queuedTurn(fixture, { number: 1, from: 'owner@gmail.com',
    to: ['agent@wonder.test'], cc: ['reviewer@gmail.com'] });
  sqlite.prepare('INSERT INTO participants (thread_id, email) VALUES (?, ?)').run('thread-1', 'reviewer@gmail.com');
  const payloads = [];
  const provider = {
    async sendEmail(payload, options) {
      payloads.push({ payload, options });
      return { data: { id: `sent-${payloads.length}` }, error: null };
    },
    async getSentEmail(id) {
      return { data: { message_id: `<${id}@tagmails.test>` }, error: null };
    },
  };
  assert.deepEqual(await sendNextOutbox(env, provider), {
    state: 'sent', jobId: 'job-1', messageId: '<sent-1@tagmails.test>',
  });
  assert.deepEqual(payloads[0].payload.to, ['owner@gmail.com']);
  assert.deepEqual(payloads[0].payload.cc, ['reviewer@gmail.com']);
  assert.equal(payloads[0].payload.headers['In-Reply-To'], '<inbound-1@gmail.com>');
  assert.equal(payloads[0].payload.headers.References, '<inbound-1@gmail.com>');
  assert.equal(payloads[0].options.idempotencyKey, 'tagmails-job-job-1');
  assert.equal(payloads[0].payload.replyTo, undefined);
  assert.deepEqual(await reaction(env, { providerEmailId: 'react-1', from: 'reviewer@gmail.com', targetId: '<sent-1@tagmails.test>' }),
    { accepted: true, reaction: true, duplicate: false });
  assert.deepEqual(await reaction(env, { providerEmailId: 'react-1', from: 'reviewer@gmail.com', targetId: '<sent-1@tagmails.test>' }),
    { accepted: true, reaction: true, duplicate: true });
  assert.deepEqual(await reaction(env, { providerEmailId: 'react-2', from: 'stranger@gmail.com', targetId: '<sent-1@tagmails.test>' }),
    { accepted: false, reaction: true });
  assert.equal(sqlite.prepare('SELECT count(*) n FROM reactions').get().n, 1);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM jobs').get().n, 1);

  await queuedTurn(fixture, { number: 2, from: 'reviewer@gmail.com',
    to: ['agent@wonder.test', 'owner@gmail.com'], cc: ['stranger@gmail.com'],
    references: ['<inbound-1@gmail.com>', '<sent-1@tagmails.test>'] });
  assert.equal((await sendNextOutbox(env, provider)).state, 'sent');
  assert.deepEqual(payloads[1].payload.to, ['reviewer@gmail.com']);
  assert.deepEqual(payloads[1].payload.cc, ['owner@gmail.com']);
  assert.equal(payloads[1].payload.headers['In-Reply-To'], '<inbound-2@gmail.com>');
  assert.equal(payloads[1].payload.headers.References,
    '<inbound-1@gmail.com> <sent-1@tagmails.test> <inbound-2@gmail.com>');
  assert.deepEqual(await reaction(env, { providerEmailId: 'react-3', from: 'owner@gmail.com', targetId: '<sent-2@tagmails.test>' }),
    { accepted: true, reaction: true, duplicate: false });
  assert.equal((await sendNextOutbox(env, provider)).state, 'idle');
  assert.equal(payloads.length, 2);
});

test('an uncertain send is not retried; an accepted send can finish Message-ID lookup later', async () => {
  const fixture = bindings();
  const { env, sqlite } = fixture;
  await queuedTurn(fixture, { number: 1, from: 'owner@gmail.com', to: ['agent@wonder.test'] });
  assert.deepEqual(await sendNextOutbox(env, {
    sendEmail: async () => { throw new Error('Connection dropped after request'); },
  }), { state: 'uncertain', jobId: 'job-1' });
  assert.equal(sqlite.prepare('SELECT state FROM outbox WHERE job_id = ?').get('job-1').state, 'uncertain');
  assert.equal((await sendNextOutbox(env, { sendEmail: async () => { throw new Error('Must not send again'); } })).state, 'idle');

  await queuedTurn(fixture, { number: 2, from: 'owner@gmail.com', to: ['agent@wonder.test'] });
  let sends = 0;
  const first = await sendNextOutbox(env, {
    sendEmail: async () => { sends += 1; return { data: { id: 'sent-2' } }; },
    getSentEmail: async () => ({ error: { message: 'Temporarily unavailable' } }),
  });
  assert.deepEqual(first, { state: 'accepted', jobId: 'job-2' });
  assert.deepEqual(await sendNextOutbox(env, {
    sendEmail: async () => { throw new Error('Must not send again'); },
    getSentEmail: async () => ({ data: { message_id: '<sent-2@tagmails.test>' } }),
  }), { state: 'sent', jobId: 'job-2', messageId: '<sent-2@tagmails.test>' });
  assert.equal(sends, 1);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM messages WHERE direction = 'outbound'").get().n, 1);
});

test('a revoked participant receives no queued result', async () => {
  const fixture = bindings();
  const { env, sqlite } = fixture;
  await queuedTurn(fixture, { number: 1, from: 'reviewer@gmail.com',
    to: ['agent@wonder.test', 'owner@gmail.com'] });
  sqlite.prepare('INSERT INTO participants (thread_id, email, revoked_at) VALUES (?, ?, CURRENT_TIMESTAMP)')
    .run('thread-1', 'reviewer@gmail.com');
  assert.deepEqual(await sendNextOutbox(env, {
    sendEmail: async () => { throw new Error('Revoked guest should not receive mail'); },
  }), { state: 'blocked', jobId: 'job-1' });
  assert.equal(sqlite.prepare('SELECT state FROM outbox').get().state, 'blocked');
});
