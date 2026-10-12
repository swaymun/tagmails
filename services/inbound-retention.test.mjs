import assert from 'node:assert/strict';
import test from 'node:test';
import { bindings } from './bindings-fixture.mjs';
import { handleAccountRequest } from './account-auth.mjs';
import { deleteExpiredInboundMime, deleteExpiredRunResults } from './inbound-retention.mjs';
import { handleInbound } from './relay-worker.mjs';

// Inserts one inbound message and its job, both received `days` ago.
function addJob(sqlite, id, days, { state = 'completed', outbox = null, outboxDays = days,
  steerState = null, resultKey = null, workspace = null, thread = 'thread-old' } = {}) {
  sqlite.prepare(`INSERT INTO messages
    (id, account_id, thread_id, provider_email_id, message_id, direction, sender_email, object_key, created_at)
    VALUES (?, 'account-1', ?, ?, ?, 'inbound', 'owner@gmail.com', ?, datetime('now', ?))`)
    .run(id, thread, `provider-${id}`, `<${id}@gmail.com>`, `inbound/${id}.eml`, `-${days} days`);
  sqlite.prepare(`INSERT INTO jobs (id, thread_id, message_id, state, steer_of, steer_state, result_key, workspace_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`)
    .run(`job-${id}`, thread, id, state, steerState ? 'job-running' : null, steerState, resultKey, workspace, `-${days} days`);
  if (outbox) sqlite.prepare("INSERT INTO outbox (job_id, state, updated_at) VALUES (?, ?, datetime('now', ?))")
    .run(`job-${id}`, outbox, `-${outboxDays} days`);
}

test('seven-day cleanup removes settled MIME, retries failed deletes, and preserves reply threading', async () => {
  const { env, sqlite, objects } = bindings();
  sqlite.prepare("INSERT INTO threads (id, account_id, subject) VALUES ('thread-old', 'account-1', 'Old work')").run();
  for (const [id, state, outbox] of [
    ['sent', 'completed', 'sent'], ['pending', 'completed', 'queued'],
    ['running', 'running', null], ['blocked', 'completed', 'blocked'],
  ]) {
    addJob(sqlite, id, 8, { state, outbox });
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
  try { await deleteExpiredInboundMime(env); }
  finally { console.error = originalError; }
  assert.equal(objects.has('inbound/sent.eml'), false);
  assert.equal(objects.has('inbound/blocked.eml'), true);
  assert.equal(sqlite.prepare('SELECT raw_deleted_at FROM messages WHERE id = ?').get('sent').raw_deleted_at !== null, true);
  assert.equal(sqlite.prepare('SELECT raw_deleted_at FROM messages WHERE id = ?').get('blocked').raw_deleted_at, null);
  assert.equal(objects.has('inbound/pending.eml'), true);
  assert.equal(objects.has('inbound/running.eml'), true);
  await deleteExpiredInboundMime(env);
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

test('raw mail expires seven days after its job ends, with or without a reply', async () => {
  const { env, sqlite, objects } = bindings();
  sqlite.prepare("INSERT INTO threads (id, account_id, subject) VALUES ('thread-old', 'account-1', 'Old work')").run();
  const cases = {
    // Deleted: no reply was sent, or the reply no longer needs the source.
    steer: [8, { steerState: 'delivered' }],
    refused: [8, { state: 'failed' }],
    uncertain: [8, { outbox: 'uncertain', outboxDays: 0 }],
    accepted: [8, { outbox: 'accepted', outboxDays: 0 }],
    askedProject: [8, { outbox: 'sent', workspace: JSON.stringify({ pending: 'sealed request' }) }],
    // Kept: recent, still in use, or finished less than seven days ago.
    recent: [6, { outbox: 'sent' }],
    pendingSteer: [8, { steerState: 'pending' }],
    queued: [8, { state: 'queued' }],
    unsentReply: [8, { outbox: 'queued' }],
    recentlySent: [9, { outbox: 'sent', outboxDays: 3 }],
  };
  for (const [id, [days, options]] of Object.entries(cases)) {
    addJob(sqlite, id, days, options);
    await env.MAIL.put(`inbound/${id}.eml`, `message-${id}`);
  }
  await deleteExpiredInboundMime(env);
  const kept = Object.keys(cases).filter((id) => objects.has(`inbound/${id}.eml`));
  assert.deepEqual(kept, ['recent', 'pendingSteer', 'queued', 'unsentReply', 'recentlySent']);
  const marked = sqlite.prepare('SELECT id FROM messages WHERE raw_deleted_at IS NOT NULL ORDER BY id').all().map((row) => row.id);
  assert.deepEqual(marked, ['accepted', 'askedProject', 'refused', 'steer', 'uncertain']);
  assert.equal(sqlite.prepare('SELECT workspace_json FROM jobs WHERE id = ?').get('job-askedProject').workspace_json, null);
});

test('run results expire thirty days after the job ends and the run page still loads', async () => {
  const { env, sqlite, objects } = bindings();
  env.GOOGLE_CLIENT_ID = 'client.apps.googleusercontent.com';
  env.SITE_ORIGIN = 'https://tagmails.test';
  const threadId = '11111111-1111-4111-8111-111111111111';
  sqlite.prepare("INSERT INTO threads (id, account_id, subject) VALUES (?, 'account-1', 'Old work')").run(threadId);
  const cases = {
    expired: [31, { outbox: 'sent' }],
    relayAnswer: [31, {}],
    failed: [31, { state: 'failed', outbox: 'blocked' }],
    recent: [29, { outbox: 'sent' }],
    recentlySent: [40, { outbox: 'sent', outboxDays: 10 }],
    unsentReply: [31, { outbox: 'queued' }],
  };
  for (const [id, [days, options]] of Object.entries(cases)) {
    addJob(sqlite, id, days, { ...options, resultKey: `results/${id}.json`, thread: threadId });
    await env.MAIL.put(`results/${id}.json`, JSON.stringify({ state: 'completed', answer: `Answer ${id}` }));
  }
  await deleteExpiredRunResults(env);
  const kept = Object.keys(cases).filter((id) => objects.has(`results/${id}.json`));
  assert.deepEqual(kept, ['recent', 'recentlySent', 'unsentReply']);
  const cleared = sqlite.prepare('SELECT id FROM jobs WHERE result_key IS NULL ORDER BY id').all().map((row) => row.id);
  assert.deepEqual(cleared, ['job-expired', 'job-failed', 'job-relayAnswer']);

  const page = await handleAccountRequest(new Request(`https://relay.test/api/site/threads/${threadId}/transcript`, {
    headers: { Origin: env.SITE_ORIGIN, Authorization: 'Bearer test' },
  }), env, { verifyIdentity: async () => ({ sub: 'google-sub-1', email: 'owner@gmail.com' }) });
  assert.equal(page.status, 200);
  const runs = Object.fromEntries((await page.json()).runs.map((run) => [run.id, run]));
  assert.equal(runs['job-expired'].answer, null);
  assert.equal(runs['job-expired'].state, 'completed');
  assert.equal(runs['job-recent'].answer, 'Answer recent');
});
