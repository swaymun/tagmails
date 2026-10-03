import assert from 'node:assert/strict';
import test from 'node:test';
import { bindings } from './bindings-fixture.mjs';
import { reconcileOneUnknownOutbox, recordDeliveryOutcome, sendNextOutbox } from './outbox.mjs';
import { handleInbound } from './relay-worker.mjs';

function queuedTurn({ env, sqlite }, { number, from, to, cc = [], inReplyTo = null, references = [], accountId = 'account-1', threadId = 'thread-1', jobId = `job-${number}`, model = null }) {
  const id = `inbound-${number}`;
  const messageId = `<inbound-${number}@gmail.com>`;
  const raw = [
    `From: ${from}`, `To: ${to.join(', ')}`,
    ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    'Subject: Shared work', `Message-ID: ${messageId}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references.length ? [`References: ${references.join(' ')}`] : []),
    'Content-Type: text/plain; charset=utf-8', '', 'Please review this.',
  ].join('\r\n');
  sqlite.prepare('INSERT OR IGNORE INTO threads (id, account_id, subject) VALUES (?, ?, ?)')
    .run(threadId, accountId, 'Shared work');
  sqlite.prepare(`INSERT INTO messages
    (id, account_id, thread_id, provider_email_id, message_id, direction, sender_email, object_key)
    VALUES (?, ?, ?, ?, ?, 'inbound', ?, ?)`).run(id, accountId, threadId, `provider-${number}`, messageId, from, `inbound/${number}.eml`);
  sqlite.prepare(`INSERT INTO jobs (id, thread_id, message_id, state, result_key, model_json)
    VALUES (?, ?, ?, 'completed', ?, ?)`).run(jobId, threadId, id, `results/${number}.json`, model && JSON.stringify(model));
  sqlite.prepare('INSERT INTO outbox (job_id) VALUES (?)').run(jobId);
  return Promise.all([
    env.MAIL.put(`inbound/${number}.eml`, raw),
    env.MAIL.put(`results/${number}.json`, JSON.stringify({ state: 'completed', summary: `Turn ${number} finished.` })),
  ]);
}

async function reaction(env, { providerEmailId, from, targetId }) {
  const message = {
    providerEmailId, messageId: `<${providerEmailId}@gmail.com>`, from,
    agentAddress: 'agent@wonder.test',
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
  assert.deepEqual(payloads[0].payload.tags, [{ name: 'tagmails_job', value: 'job-1' }]);
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
    inReplyTo: '<sent-1@tagmails.test>',
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

test('development sender replies to the account owner through the inbound alias', async () => {
  const fixture = bindings();
  const { env, sqlite } = fixture;
  env.RESEND_TEST_FROM = 'onboarding@resend.dev';
  await queuedTurn(fixture, { number: 1, from: 'owner@gmail.com', to: ['agent@wonder.test'] });
  let sent;
  assert.equal((await sendNextOutbox(env, {
    sendEmail: async (payload) => { sent = payload; return { data: { id: 'test-sent-1' } }; },
    getSentEmail: async () => ({ data: { message_id: '<test-sent-1@resend.dev>' } }),
  })).state, 'sent');
  assert.equal(sent.from, 'onboarding@resend.dev');
  assert.equal(sent.replyTo, 'agent@wonder.test');
  assert.deepEqual(sent.to, ['owner@gmail.com']);
  assert.equal(sent.cc, undefined);

  await queuedTurn(fixture, { number: 2, from: 'owner@gmail.com',
    to: ['agent@wonder.test'], cc: ['reviewer@gmail.com'] });
  sqlite.prepare('INSERT INTO participants (thread_id, email) VALUES (?, ?)')
    .run('thread-1', 'reviewer@gmail.com');
  assert.equal((await sendNextOutbox(env, {
    sendEmail: async () => { throw new Error('Test sender must not email participants'); },
  })).state, 'blocked');
});

test('the result email names the model recorded at receipt, including an explicit override', async () => {
  const fixture = bindings();
  const { env, sqlite } = fixture;
  await queuedTurn(fixture, { number: 1, from: 'owner@gmail.com', to: ['agent@wonder.test'],
    model: { id: 'claude-sonnet-5-5', effort: 'medium', source: 'explicit' } });
  // An account preference change after receipt must not relabel a queued result.
  sqlite.prepare('UPDATE accounts SET default_model = ? WHERE id = ?').run('gpt-6.1-sol', 'account-1');
  let sent;
  assert.equal((await sendNextOutbox(env, {
    sendEmail: async (payload) => { sent = payload; return { data: { id: 'model-sent-1' } }; },
    getSentEmail: async () => ({ data: { message_id: '<model-sent-1@tagmails.test>' } }),
  })).state, 'sent');
  assert.match(sent.text, /Selected model: Claude Code Sonnet 5\.5 \(medium; requested in this email\)/);
  assert.match(sent.html, /Selected model: Claude Code Sonnet 5\.5 \(medium; requested in this email\)/);
  assert.doesNotMatch(sent.text, /GPT-6\.1 Sol/);
});

test('a completed write turn reports the agent answer without claiming verified edits', async () => {
  const fixture = bindings();
  const { env } = fixture;
  await queuedTurn(fixture, { number: 1, from: 'owner@gmail.com', to: ['agent@wonder.test'] });
  await env.MAIL.put('results/1.json', JSON.stringify({ runtime: 'codex-app-server-write',
    state: 'completed', summary: 'I created report.txt.' }));
  let payload;
  assert.equal((await sendNextOutbox(env, {
    sendEmail: async (value) => { payload = value; return { data: { id: 'write-1' } }; },
    getSentEmail: async () => ({ data: { message_id: '<write-1@tagmails.test>' } }),
  })).state, 'sent');
  assert.match(payload.text, /^Agent reply\n/);
  assert.match(payload.text, /Verify local file changes before relying on them\./);
  assert.match(payload.html, /<h1>Agent reply<\/h1>/);
});

test('a denied local action asks for review without inventing an approval screen', async () => {
  const fixture = bindings();
  const { env } = fixture;
  await queuedTurn(fixture, { number: 1, from: 'owner@gmail.com', to: ['agent@wonder.test'] });
  await env.MAIL.put('results/1.json', JSON.stringify({ state: 'needs_approval',
    summary: 'The requested file is outside the selected workspace.' }));
  let payload;
  assert.equal((await sendNextOutbox(env, {
    sendEmail: async (value) => { payload = value; return { data: { id: 'review-1' } }; },
    getSentEmail: async () => ({ data: { message_id: '<review-1@tagmails.test>' } }),
  })).state, 'sent');
  assert.match(payload.text, /^Needs your attention/m);
  assert.match(payload.text, /Review the request and local permissions/);
  assert.doesNotMatch(payload.text, /waiting for your approval in the connected app/i);
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

test('an interrupted provider send becomes uncertain after the scheduled run limit', async () => {
  const fixture = bindings();
  const { env, sqlite } = fixture;
  await queuedTurn(fixture, { number: 1, from: 'owner@gmail.com', to: ['agent@wonder.test'] });
  sqlite.prepare("UPDATE outbox SET state = 'sending', updated_at = datetime('now', '-10 minutes') WHERE job_id = ?")
    .run('job-1');
  const provider = { sendEmail: async () => { throw new Error('Never retry an unknown send'); } };
  assert.equal((await sendNextOutbox(env, provider)).state, 'idle');
  sqlite.prepare("UPDATE outbox SET updated_at = datetime('now', '-21 minutes') WHERE job_id = ?")
    .run('job-1');
  assert.deepEqual(await sendNextOutbox(env, provider), { state: 'uncertain', jobId: 'job-1' });
  assert.equal(sqlite.prepare('SELECT state FROM outbox WHERE job_id = ?').get('job-1').state, 'uncertain');
  assert.equal((await sendNextOutbox(env, provider)).state, 'idle');
});

test('a matching signed sent event reconciles an uncertain send without resending', async () => {
  const fixture = bindings();
  const { env, sqlite } = fixture;
  const jobId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const providerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await queuedTurn(fixture, { number: 1, from: 'owner@gmail.com', to: ['agent@wonder.test'], jobId });
  assert.equal((await sendNextOutbox(env, {
    sendEmail: async () => { throw new Error('Connection dropped after acceptance'); },
  })).state, 'uncertain');
  const event = { jobId, providerEmailId: providerId, messageId: '<sent@tagmails.test>',
    from: 'agent@wonder.test', to: ['owner@gmail.com'], cc: [], subject: 'Re: Shared work' };
  const notify = (sent) => handleInbound(new Request('https://relay.test/webhooks/resend', {
    method: 'POST', body: '{}',
  }), env, { inspect: async () => ({ sent }) });
  assert.deepEqual(await (await notify({ ...event, to: ['stranger@gmail.com'] })).json(), { accepted: false });
  assert.equal(sqlite.prepare('SELECT state FROM outbox WHERE job_id = ?').get(jobId).state, 'uncertain');
  assert.deepEqual(await (await notify(event)).json(), { accepted: true, sentEvent: true });
  assert.equal(sqlite.prepare('SELECT state FROM outbox WHERE job_id = ?').get(jobId).state, 'accepted');
  assert.deepEqual(await sendNextOutbox(env, {
    sendEmail: async () => { throw new Error('Must not resend'); },
    getSentEmail: async (id) => {
      assert.equal(id, providerId);
      return { data: { message_id: event.messageId } };
    },
  }), { state: 'sent', jobId, messageId: event.messageId });
  assert.deepEqual(await (await notify(event)).json(), { accepted: true, duplicate: true });
  assert.equal(sqlite.prepare("SELECT count(*) n FROM messages WHERE direction = 'outbound'").get().n, 1);
});

test('one intended recipient can reconcile a shared reply sent event', async () => {
  const fixture = bindings();
  const { env, sqlite } = fixture;
  const jobId = '12121212-1212-4212-8212-121212121212';
  const providerId = '34343434-3434-4434-8434-343434343434';
  await queuedTurn(fixture, { number: 1, from: 'owner@gmail.com', to: ['agent@wonder.test'],
    cc: ['guest@gmail.com'], jobId });
  sqlite.prepare('INSERT INTO participants (thread_id, email) VALUES (?, ?)').run('thread-1', 'guest@gmail.com');
  assert.equal((await sendNextOutbox(env, {
    sendEmail: async () => { throw new Error('Connection dropped after acceptance'); },
  })).state, 'uncertain');
  const notify = async (to) => (await handleInbound(new Request('https://relay.test/webhooks/resend', {
    method: 'POST', body: '{}',
  }), env, { inspect: async () => ({ sent: { jobId, providerEmailId: providerId,
    messageId: '<shared@tagmails.test>', from: 'agent@wonder.test', to,
    cc: [], subject: 'Re: Shared work' } }) })).json();
  assert.deepEqual(await notify(['stranger@gmail.com']), { accepted: false });
  assert.deepEqual(await notify(['guest@gmail.com']), { accepted: true, sentEvent: true });
  assert.equal(sqlite.prepare('SELECT state FROM outbox WHERE job_id = ?').get(jobId).state, 'accepted');
  assert.deepEqual(await sendNextOutbox(env, {
    sendEmail: async () => { throw new Error('Must not resend'); },
    getSentEmail: async () => ({ data: { message_id: '<shared@tagmails.test>' } }),
  }), { state: 'sent', jobId, messageId: '<shared@tagmails.test>' });
  assert.equal(sqlite.prepare("SELECT count(*) n FROM messages WHERE direction = 'outbound'").get().n, 1);
});

test('provider lookup reconciles only an exactly tagged uncertain reply', async () => {
  const fixture = bindings();
  const { env, sqlite } = fixture;
  const jobId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const providerId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  await queuedTurn(fixture, { number: 1, from: 'owner@gmail.com', to: ['agent@wonder.test'], jobId });
  assert.equal((await sendNextOutbox(env, {
    sendEmail: async () => { throw new Error('Connection lost after send'); },
  })).state, 'uncertain');
  await queuedTurn(fixture, { number: 2, from: 'owner@gmail.com', to: ['agent@wonder.test'] });
  sqlite.prepare("UPDATE outbox SET updated_at = datetime('now', '-20 minutes') WHERE job_id = ?").run(jobId);
  let tag = 'another-job';
  let lists = 0;
  const provider = {
    sendEmail: async () => { throw new Error('An uncertain reply must not be sent again'); },
    listSentEmails: async (options) => {
      lists += 1;
      assert.deepEqual(options, { limit: 100 });
      return { data: { data: [{ id: providerId, from: 'TagMails <agent@wonder.test>',
        to: ['owner@gmail.com'], cc: null, subject: 'Re: Shared work' }] } };
    },
    getSentEmail: async () => ({ data: { id: providerId, message_id: '<found@tagmails.test>',
      from: 'TagMails <agent@wonder.test>', to: ['owner@gmail.com'], cc: null,
      subject: 'Re: Shared work', tags: [{ name: 'tagmails_job', value: tag }] } }),
  };
  assert.deepEqual(await reconcileOneUnknownOutbox(env, provider), { state: 'uncertain', jobId });
  assert.equal(sqlite.prepare('SELECT state FROM outbox WHERE job_id = ?').get(jobId).state, 'uncertain');
  assert.equal((await reconcileOneUnknownOutbox(env, provider)).state, 'idle');
  assert.equal(lists, 1);
  sqlite.prepare("UPDATE outbox SET updated_at = datetime('now', '-20 minutes') WHERE job_id = ?").run(jobId);
  tag = jobId;
  assert.deepEqual(await reconcileOneUnknownOutbox(env, provider), { state: 'accepted', jobId });
  assert.equal(sqlite.prepare('SELECT provider_email_id FROM outbox WHERE job_id = ?').get(jobId).provider_email_id,
    providerId);
  assert.equal((await sendNextOutbox(env, provider)).state, 'sent');
  assert.equal(sqlite.prepare("SELECT count(*) n FROM messages WHERE direction = 'outbound'").get().n, 1);
  assert.equal(sqlite.prepare('SELECT state FROM outbox WHERE job_id = ?').get('job-2').state, 'queued');
});

test('recipient delivery events are isolated and older updates cannot overwrite them', async () => {
  const fixture = bindings();
  const { env, sqlite } = fixture;
  env.BILLING_TEST_MODE = 'true';
  env.STRIPE_SECRET_KEY = 'sk_test_local';
  env.STRIPE_WEBHOOK_SECRET = 'whsec_local';
  const jobId = '99999999-9999-4999-8999-999999999999';
  const providerId = '88888888-8888-4888-8888-888888888888';
  await queuedTurn(fixture, { number: 1, from: 'owner@gmail.com', to: ['agent@wonder.test'],
    cc: ['guest@gmail.com'], jobId });
  sqlite.prepare("INSERT INTO test_email_charges (job_id, account_id, amount_cents, state) VALUES (?, 'account-1', 5, 'reserved')").run(jobId);
  sqlite.prepare('INSERT INTO participants (thread_id, email) VALUES (?, ?)').run('thread-1', 'guest@gmail.com');
  assert.equal((await sendNextOutbox(env, {
    sendEmail: async () => ({ data: { id: providerId } }),
    getSentEmail: async () => ({ data: { message_id: '<sent@tagmails.test>' } }),
  })).state, 'sent');
  const base = { jobId, providerEmailId: providerId, from: 'agent@wonder.test',
    subject: 'Re: Shared work', eventId: 'msg_delivery_1' };
  const notify = async (deliveryOutcome) => (await handleInbound(new Request('https://relay.test/webhooks/resend', {
    method: 'POST', body: '{}',
  }), env, { inspect: async () => ({ deliveryOutcome }) })).json();
  assert.deepEqual(await notify({ ...base, recipient: 'other@gmail.com', status: 'delivered',
    eventAt: '2026-10-03T10:00:00.000Z' }), { accepted: false });
  assert.deepEqual(await notify({ ...base, providerEmailId: 'different-provider',
    recipient: 'owner@gmail.com', status: 'delivered', eventAt: '2026-10-03T10:00:00.000Z' }),
  { accepted: false });
  assert.deepEqual(await notify({ ...base, recipient: 'owner@gmail.com', status: 'delivered',
    eventAt: '2026-10-03T10:02:00.000Z' }), { accepted: true, deliveryOutcome: true });
  assert.deepEqual(await notify({ ...base, recipient: 'owner@gmail.com', status: 'delayed',
    eventAt: '2026-10-03T10:01:00.000Z' }), { accepted: true, deliveryOutcome: true });
  assert.deepEqual(await notify({ ...base, recipient: 'owner@gmail.com', status: 'bounced',
    eventAt: '2026-10-03T10:01:30.000Z' }), { accepted: true, deliveryOutcome: true });
  assert.deepEqual(await notify({ ...base, recipient: 'guest@gmail.com', status: 'bounced',
    eventAt: '2026-10-03T10:03:00.000Z' }), { accepted: true, deliveryOutcome: true });
  assert.equal(sqlite.prepare('SELECT state FROM test_email_charges WHERE job_id = ?').get(jobId).state, 'settled');
  assert.deepEqual(sqlite.prepare(`SELECT recipient_email, status FROM delivery_recipients
    WHERE job_id = ? ORDER BY recipient_email`).all(jobId).map((row) => ({ ...row })), [
    { recipient_email: 'guest@gmail.com', status: 'bounced' },
    { recipient_email: 'owner@gmail.com', status: 'delivered' },
  ]);
});

test('a failed primary recipient releases the test charge even when a copied guest receives the reply', async () => {
  const fixture = bindings();
  const { env, sqlite } = fixture;
  env.BILLING_TEST_MODE = 'true';
  env.STRIPE_SECRET_KEY = 'sk_test_local';
  env.STRIPE_WEBHOOK_SECRET = 'whsec_local';
  const jobId = '66666666-6666-4666-8666-666666666666';
  const providerEmailId = '55555555-5555-4555-8555-555555555555';
  await queuedTurn(fixture, { number: 1, from: 'owner@gmail.com', to: ['agent@wonder.test'],
    cc: ['guest@gmail.com'], jobId });
  sqlite.prepare('INSERT INTO participants (thread_id, email) VALUES (?, ?)').run('thread-1', 'guest@gmail.com');
  sqlite.prepare("INSERT INTO test_email_charges (job_id, account_id, amount_cents, state) VALUES (?, 'account-1', 5, 'reserved')").run(jobId);
  assert.equal((await sendNextOutbox(env, {
    sendEmail: async () => ({ data: { id: providerEmailId } }),
    getSentEmail: async () => ({ data: { message_id: '<mixed@tagmails.test>' } }),
  })).state, 'sent');
  const base = { jobId, providerEmailId, from: 'agent@wonder.test', subject: 'Re: Shared work' };
  assert.deepEqual(await recordDeliveryOutcome(env, { ...base, recipient: 'guest@gmail.com', status: 'delivered',
    eventAt: '2026-10-03T10:00:00.000Z' }), { accepted: true, deliveryOutcome: true });
  assert.equal(sqlite.prepare('SELECT state FROM test_email_charges WHERE job_id = ?').get(jobId).state, 'settled');
  assert.deepEqual(await recordDeliveryOutcome(env, { ...base, recipient: 'owner@gmail.com', status: 'suppressed',
    eventAt: '2026-10-03T10:01:00.000Z' }), { accepted: true, deliveryOutcome: true });
  assert.equal(sqlite.prepare('SELECT state FROM test_email_charges WHERE job_id = ?').get(jobId).state, 'released');
});

test('a sent event arriving before the send response cannot create a second reply', async () => {
  const fixture = bindings();
  const { env, sqlite } = fixture;
  const jobId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const providerId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  await queuedTurn(fixture, { number: 1, from: 'owner@gmail.com', to: ['agent@wonder.test'], jobId });
  const first = await sendNextOutbox(env, {
    sendEmail: async (payload) => {
      const response = await handleInbound(new Request('https://relay.test/webhooks/resend', {
        method: 'POST', body: '{}',
      }), env, { inspect: async () => ({ sent: {
        jobId, providerEmailId: providerId, messageId: '<early@tagmails.test>',
        from: payload.from, to: payload.to, cc: payload.cc ?? [], subject: payload.subject,
      } }) });
      assert.deepEqual(await response.json(), { accepted: true, sentEvent: true });
      return { data: { id: providerId } };
    },
  });
  assert.deepEqual(first, { state: 'accepted', jobId });
  assert.deepEqual(await sendNextOutbox(env, {
    sendEmail: async () => { throw new Error('Must not send twice'); },
    getSentEmail: async () => ({ data: { message_id: '<early@tagmails.test>' } }),
  }), { state: 'sent', jobId, messageId: '<early@tagmails.test>' });
  assert.equal(sqlite.prepare("SELECT count(*) n FROM messages WHERE direction = 'outbound'").get().n, 1);
});

test('an accepted send finalizes when its outbound message was already recorded', async () => {
  const fixture = bindings();
  const { env, sqlite } = fixture;
  await queuedTurn(fixture, { number: 1, from: 'owner@gmail.com', to: ['agent@wonder.test'] });
  sqlite.prepare("UPDATE outbox SET state = 'accepted', provider_email_id = ? WHERE job_id = ?")
    .run('sent-1', 'job-1');
  sqlite.prepare(`INSERT INTO messages
    (id, account_id, thread_id, provider_email_id, message_id, direction, sender_email, object_key)
    VALUES (?, ?, ?, ?, ?, 'outbound', ?, ?)`)
    .run('outbound-1', 'account-1', 'thread-1', 'sent-1', '<sent-1@tagmails.test>',
      'agent@wonder.test', 'outbound/account-1/job-1.json');
  const provider = {
    sendEmail: async () => { throw new Error('An accepted send must not be repeated'); },
    getSentEmail: async () => ({ data: { message_id: '<sent-1@tagmails.test>' } }),
  };
  assert.equal((await sendNextOutbox(env, provider)).state, 'sent');
  assert.equal(sqlite.prepare("SELECT count(*) n FROM messages WHERE direction = 'outbound'").get().n, 1);
  assert.equal(sqlite.prepare("SELECT state FROM outbox WHERE job_id = ?").get('job-1').state, 'sent');
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

test('revoking a participant after preparation blocks the provider send', async () => {
  const fixture = bindings();
  const { env, sqlite, objects } = fixture;
  await queuedTurn(fixture, { number: 1, from: 'owner@gmail.com',
    to: ['agent@wonder.test'], cc: ['reviewer@gmail.com'] });
  sqlite.prepare('INSERT INTO participants (thread_id, email) VALUES (?, ?)')
    .run('thread-1', 'reviewer@gmail.com');
  const put = env.MAIL.put;
  env.MAIL.put = async (key, value, options) => {
    await put(key, value, options);
    if (key.startsWith('outbound/')) sqlite.prepare(`UPDATE participants SET revoked_at = CURRENT_TIMESTAMP
      WHERE thread_id = ? AND email = ?`).run('thread-1', 'reviewer@gmail.com');
  };
  assert.deepEqual(await sendNextOutbox(env, {
    sendEmail: async () => { throw new Error('Revoked participant must not receive mail'); },
  }), { state: 'blocked', jobId: 'job-1' });
  assert.equal(sqlite.prepare('SELECT state FROM outbox').get().state, 'blocked');
  assert.equal(objects.has('outbound/account-1/job-1.json'), false);
});

test('one outbox sends from each account address', async () => {
  const fixture = bindings();
  const { env, sqlite } = fixture;
  sqlite.prepare('INSERT INTO accounts (id, google_sub, owner_email, agent_email) VALUES (?, ?, ?, ?)')
    .run('account-2', 'google-2', 'second@gmail.com', 'u-second@tagmails.test');
  await queuedTurn(fixture, { number: 1, from: 'owner@gmail.com', to: ['agent@wonder.test'] });
  await queuedTurn(fixture, { number: 2, from: 'second@gmail.com', to: ['u-second@tagmails.test'],
    accountId: 'account-2', threadId: 'thread-2' });
  const senders = [];
  const provider = {
    sendEmail: async (payload) => { senders.push(payload.from); return { data: { id: `sent-${senders.length}` } }; },
    getSentEmail: async (id) => ({ data: { message_id: `<${id}@tagmails.test>` } }),
  };
  assert.equal((await sendNextOutbox(env, provider)).state, 'sent');
  assert.equal((await sendNextOutbox(env, provider)).state, 'sent');
  assert.deepEqual(senders, ['agent@wonder.test', 'u-second@tagmails.test']);
});

test('guest-only replies link to the Site transcript only after participant access is enabled', async () => {
  const fixture = bindings();
  const { env, sqlite } = fixture;
  env.PUBLIC_ORIGIN = 'https://relay.tagmails.test';
  env.SITE_ORIGIN = 'https://site.tagmails.test';
  const receiptJobId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await queuedTurn(fixture, { number: 1, from: 'owner@gmail.com', to: ['agent@wonder.test'], jobId: receiptJobId });
  const payloads = [];
  const provider = {
    sendEmail: async (payload) => { payloads.push(payload); return { data: { id: `sent-${payloads.length}` } }; },
    getSentEmail: async (id) => ({ data: { message_id: `<${id}@tagmails.test>` } }),
  };
  assert.equal((await sendNextOutbox(env, provider)).state, 'sent');
  assert.ok(payloads[0].html.includes(`https://site.tagmails.test/run?id=${receiptJobId}`));
  assert.doesNotMatch(payloads[0].html, /relay\.tagmails\.test\/runs/);
  sqlite.prepare('INSERT INTO participants (thread_id, email) VALUES (?, ?)').run('thread-1', 'reviewer@gmail.com');
  await queuedTurn(fixture, { number: 2, from: 'reviewer@gmail.com', to: ['agent@wonder.test'] });
  assert.equal((await sendNextOutbox(env, provider)).state, 'sent');
  assert.doesNotMatch(payloads[1].html, /\/run\?id=|\/runs\//);
  assert.doesNotMatch(payloads[1].text, /\/run\?id=|\/runs\//);
  env.SITE_PARTICIPANT_TRANSCRIPTS = 'true';
  const guestJobId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  await queuedTurn(fixture, { number: 3, from: 'reviewer@gmail.com', to: ['agent@wonder.test'], jobId: guestJobId });
  assert.equal((await sendNextOutbox(env, provider)).state, 'sent');
  assert.ok(payloads[2].html.includes(`https://site.tagmails.test/run?id=${guestJobId}`));
  assert.ok(payloads[2].text.includes(`https://site.tagmails.test/run?id=${guestJobId}`));
  assert.doesNotMatch(payloads[2].html, /relay\.tagmails\.test\/runs/);
});

test('without a separate Site, an owner reply links to the Worker receipt', async () => {
  const fixture = bindings();
  fixture.env.PUBLIC_ORIGIN = 'https://relay.tagmails.test';
  const jobId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  await queuedTurn(fixture, { number: 1, from: 'owner@gmail.com', to: ['agent@wonder.test'], jobId });
  let sent;
  assert.equal((await sendNextOutbox(fixture.env, {
    sendEmail: async (payload) => { sent = payload; return { data: { id: 'sent-owner' } }; },
    getSentEmail: async () => ({ data: { message_id: '<sent-owner@tagmails.test>' } }),
  })).state, 'sent');
  assert.ok(sent.html.includes(`https://relay.tagmails.test/runs/${jobId}`));
  assert.doesNotMatch(sent.html, /\/run\?id=/);
});
