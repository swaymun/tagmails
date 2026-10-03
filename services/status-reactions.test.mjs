import assert from 'node:assert/strict';
import test from 'node:test';
import { bindings } from './bindings-fixture.mjs';
import { sendNextStatusReaction } from './status-reactions.mjs';

function queuedGuest() {
  const fixture = bindings();
  const { env, sqlite } = fixture;
  env.STATUS_REACTIONS_ENABLED = 'true';
  sqlite.prepare("INSERT INTO threads (id, account_id, subject) VALUES ('thread-1', 'account-1', 'Shared')").run();
  sqlite.prepare("INSERT INTO participants (thread_id, email) VALUES ('thread-1', 'guest@gmail.com')").run();
  sqlite.prepare(`INSERT INTO messages
    (id, account_id, thread_id, provider_email_id, message_id, direction, sender_email, object_key)
    VALUES ('message-1', 'account-1', 'thread-1', 'mail-1', '<guest@gmail.com>', 'inbound', 'guest@gmail.com', 'inbound/1')`).run();
  const jobId = '22222222-2222-4222-8222-222222222222';
  sqlite.prepare("INSERT INTO jobs (id, thread_id, message_id, state) VALUES (?, 'thread-1', 'message-1', 'queued')")
    .run(jobId);
  sqlite.prepare("INSERT INTO status_reactions (job_id, status) VALUES (?, 'received')").run(jobId);
  return { env, sqlite, jobId };
}

test('revoking a participant blocks a queued Gmail status reaction', async () => {
  const { env, sqlite, jobId } = queuedGuest();
  sqlite.prepare("UPDATE participants SET revoked_at = CURRENT_TIMESTAMP WHERE thread_id = 'thread-1'").run();
  let sends = 0;
  assert.deepEqual(await sendNextStatusReaction(env, { send: async () => { sends++; } }),
    { state: 'blocked', jobId, status: 'received' });
  assert.equal(sends, 0);
  assert.equal(sqlite.prepare('SELECT state FROM status_reactions').get().state, 'blocked');
});

test('an uncertain SMTP outcome is held without a duplicate send', async () => {
  const { env, sqlite, jobId } = queuedGuest();
  let sends = 0;
  const send = async () => { sends++; throw new Error('Connection lost after DATA'); };
  assert.deepEqual(await sendNextStatusReaction(env, { send }),
    { state: 'uncertain', jobId, status: 'received' });
  assert.equal((await sendNextStatusReaction(env, { send })).state, 'idle');
  assert.equal(sends, 1);
  assert.equal(sqlite.prepare('SELECT state FROM status_reactions').get().state, 'uncertain');
});
