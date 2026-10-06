import assert from 'node:assert/strict';
import test from 'node:test';
import { bindings } from './bindings-fixture.mjs';
import { purgeSettledOutboundBodies, reconcileOneUnknownOutbox, reconcileSentEvent, recordDeliveryOutcome, sendNextOutbox } from './outbox.mjs';
import { handleInbound } from './relay-worker.mjs';

function queuedTurn({ env, sqlite }, { number, from, to, cc = [], inReplyTo = null, references = [], accountId = 'account-1', threadId = 'thread-1', jobId = `job-${number}`, model = null, receivedAgent = null }) {
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
    (id, account_id, thread_id, provider_email_id, message_id, direction, sender_email, object_key, agent_email)
    VALUES (?, ?, ?, ?, ?, 'inbound', ?, ?, ?)`).run(id, accountId, threadId, `provider-${number}`, messageId, from, `inbound/${number}.eml`, receivedAgent);
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

test('settled replies purge rendered bodies while retaining delivery and reaction checks', async () => {
  const fixture = bindings();
  const { env, sqlite, objects } = fixture;
  await queuedTurn(fixture, { number: 1, from: 'owner@gmail.com', to: ['agent@wonder.test'] });
  const provider = {
    sendEmail: async () => ({ data: { id: 'sent-1' } }),
    getSentEmail: async () => ({ data: { message_id: '<sent-1@tagmails.test>' } }),
  };
  assert.equal((await sendNextOutbox(env, provider)).state, 'sent');
  const key = 'outbound/account-1/job-1.json';
  assert.ok(objects.has(key));
  // D1 never holds the rendered body; it stays in the R2 copy until the send settles.
  const stored = JSON.parse(sqlite.prepare("SELECT payload_json FROM outbox WHERE job_id = 'job-1'").get().payload_json);
  assert.equal(stored.html, undefined);
  assert.equal(stored.bodyStored, true);

  const originalDelete = env.MAIL.delete;
  env.MAIL.delete = async () => { throw new Error('Temporary R2 failure'); };
  assert.equal(await purgeSettledOutboundBodies(env), 0);
  assert.ok(objects.has(key));
  env.MAIL.delete = originalDelete;
  assert.equal(await purgeSettledOutboundBodies(env), 1);
  assert.equal(await purgeSettledOutboundBodies(env), 0);
  assert.equal(objects.has(key), false);
  const compact = JSON.parse(sqlite.prepare("SELECT payload_json FROM outbox WHERE job_id = 'job-1'").get().payload_json);
  assert.deepEqual(Object.keys(compact).sort(), ['from', 'subject', 'tags', 'to']);
  assert.equal(compact.subject, 'Re: Shared work');
  assert.deepEqual(await reaction(env, { providerEmailId: 'reaction-1', from: 'owner@gmail.com',
    targetId: '<sent-1@tagmails.test>' }), { accepted: true, reaction: true, duplicate: false });
  assert.deepEqual(await reconcileSentEvent(env, { jobId: 'job-1', providerEmailId: 'sent-1',
    messageId: '<sent-1@tagmails.test>', from: 'agent@wonder.test',
    to: ['owner@gmail.com'], cc: [], subject: 'Re: Shared work' }),
  { accepted: true, duplicate: true });
  assert.deepEqual(await recordDeliveryOutcome(env, { jobId: 'job-1', providerEmailId: 'sent-1',
    recipient: 'owner@gmail.com', from: 'agent@wonder.test', subject: 'Re: Shared work',
    status: 'delivered', eventAt: '2026-10-03T23:00:00.000Z', eventId: 'delivery-1' }),
  { accepted: true, deliveryOutcome: true });
});

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

test('a queued message received at the old alias replies from the new account address', async () => {
  const fixture = bindings();
  const { env, sqlite } = fixture;
  sqlite.prepare('UPDATE accounts SET agent_email = ? WHERE id = ?').run('agent@tagmails.test', 'account-1');
  await queuedTurn(fixture, { number: 1, from: 'owner@gmail.com',
    to: ['agent@wonder.test', 'agent@tagmails.test'], receivedAgent: 'agent@wonder.test' });
  sqlite.prepare('INSERT INTO participants (thread_id, email) VALUES (?, ?)')
    .run('thread-1', 'agent@tagmails.test');
  let sent;
  assert.equal((await sendNextOutbox(env, {
    sendEmail: async (payload) => { sent = payload; return { data: { id: 'migrated-sent' } }; },
    getSentEmail: async () => ({ data: { message_id: '<migrated-sent@tagmails.test>' } }),
  })).state, 'sent');
  assert.equal(sent.from, 'agent@tagmails.test');
  assert.deepEqual(sent.to, ['owner@gmail.com']);
  assert.equal(sent.cc, undefined);
  assert.equal(sent.headers['In-Reply-To'], '<inbound-1@gmail.com>');
});

test('a free clarification can reply while an earlier task waits for the Mac or credits', async () => {
  const fixture = bindings();
  const { env, sqlite } = fixture;
  await queuedTurn(fixture, { number: 1, from: 'owner@gmail.com', to: ['agent@wonder.test'] });
  sqlite.prepare("UPDATE jobs SET state = 'queued', result_key = NULL WHERE id = 'job-1'").run();
  sqlite.prepare("DELETE FROM outbox WHERE job_id = 'job-1'").run();
  await queuedTurn(fixture, { number: 2, from: 'owner@gmail.com', to: ['agent@wonder.test'],
    inReplyTo: '<inbound-1@gmail.com>' });
  await env.MAIL.put('results/2.json', JSON.stringify({ runtime: 'relay',
    state: 'needs_clarification', summary: 'Please choose an available model.' }));
  let sent = 0;
  let clarification;
  const provider = {
    sendEmail: async (payload) => {
      if (!sent) clarification = payload;
      return { data: { id: `ordered-${++sent}` } };
    },
    getSentEmail: async (id) => ({ data: { message_id: `<${id}@tagmails.test>` } }),
  };
  assert.equal((await sendNextOutbox(env, provider)).jobId, 'job-2');
  assert.equal(sent, 1);
  assert.doesNotMatch(clarification.html, /Waiting for your reply|Needs reply/);
  sqlite.prepare("UPDATE jobs SET state = 'completed', result_key = 'results/1.json' WHERE id = 'job-1'").run();
  sqlite.prepare("INSERT INTO outbox (job_id) VALUES ('job-1')").run();
  assert.equal((await sendNextOutbox(env, provider)).jobId, 'job-1');
  assert.equal(sent, 2);
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

test('a permanently missing outbox source blocks only that reply', async () => {
  const fixture = bindings();
  const { env, sqlite, objects } = fixture;
  await queuedTurn(fixture, { number: 1, from: 'owner@gmail.com', to: ['agent@wonder.test'] });
  await queuedTurn(fixture, { number: 2, from: 'owner@gmail.com', to: ['agent@wonder.test'] });
  objects.delete('inbound/1.eml');
  let sent = 0;
  const provider = {
    sendEmail: async () => ({ data: { id: `sent-${++sent}` } }),
    getSentEmail: async (id) => ({ data: { message_id: `<${id}@tagmails.test>` } }),
  };
  assert.deepEqual(await sendNextOutbox(env, provider), { state: 'blocked', jobId: 'job-1' });
  assert.equal(sqlite.prepare('SELECT state FROM outbox WHERE job_id = ?').get('job-1').state, 'blocked');
  assert.equal((await sendNextOutbox(env, provider)).state, 'sent');
  assert.equal(sent, 1);
});

test('a transient storage read leaves the outbox queued for retry', async () => {
  const fixture = bindings();
  const { env, sqlite } = fixture;
  await queuedTurn(fixture, { number: 1, from: 'owner@gmail.com', to: ['agent@wonder.test'] });
  const get = env.MAIL.get;
  env.MAIL.get = async () => { throw new Error('Temporary R2 error'); };
  await assert.rejects(sendNextOutbox(env), /Temporary R2 error/);
  assert.equal(sqlite.prepare('SELECT state FROM outbox WHERE job_id = ?').get('job-1').state, 'queued');
  env.MAIL.get = get;
  assert.equal((await sendNextOutbox(env, {
    sendEmail: async () => ({ data: { id: 'sent-after-retry' } }),
    getSentEmail: async () => ({ data: { message_id: '<sent-after-retry@tagmails.test>' } }),
  })).state, 'sent');
});

test('the result email names the model recorded at receipt, including an explicit override', async () => {
  const fixture = bindings();
  const { env, sqlite } = fixture;
  env.SITE_ORIGIN = 'https://tagmails.example';
  await queuedTurn(fixture, { number: 1, from: 'owner@gmail.com', to: ['agent@wonder.test'],
    model: { id: 'claude-sonnet-5-5', effort: 'medium', source: 'explicit' } });
  // An account preference change after receipt must not relabel a queued result.
  sqlite.prepare('UPDATE accounts SET default_model = ? WHERE id = ?').run('gpt-6.1-sol', 'account-1');
  let sent;
  assert.equal((await sendNextOutbox(env, {
    sendEmail: async (payload) => { sent = payload; return { data: { id: 'model-sent-1' } }; },
    getSentEmail: async () => ({ data: { message_id: '<model-sent-1@tagmails.test>' } }),
  })).state, 'sent');
  assert.match(sent.text, /Claude Sonnet 5\.5 Medium/);
  assert.match(sent.html, /<span>Claude Sonnet 5\.5 Medium<\/span>/);
  assert.doesNotMatch(sent.text, /Done|Waiting for your reply/);
  assert.doesNotMatch(sent.html, /Done|Waiting for your reply/);
  for (const content of [sent.text, sent.html.slice(sent.html.indexOf('<footer'))]) {
    assert.ok(content.indexOf('Transcript') < content.indexOf('Claude Sonnet'));
    assert.ok(content.indexOf('Medium') < content.indexOf('TagMails'));
  }
  assert.doesNotMatch(sent.html, /<h2>What happened<\/h2>|<h2>Checks and limits<\/h2>|<ul>/);
  assert.match(sent.html, /class="mark"/);
  assert.match(sent.html, /href="https:\/\/tagmails\.example\/"/);
  assert.doesNotMatch(sent.text, /GPT-6\.1 Sol/);
});

test('the owner footer opens the run in the app that ran it', async () => {
  const fixture = bindings();
  const { env } = fixture;
  env.SITE_ORIGIN = 'https://tagmails.example';
  await queuedTurn(fixture, { number: 1, from: 'owner@gmail.com', to: ['agent@wonder.test'] });
  await env.MAIL.put('results/1.json', JSON.stringify({ runtime: 'claude-cli-write', state: 'completed',
    summary: 'Done.', session: { harness: 'claude', id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' } }));
  let sent;
  assert.equal((await sendNextOutbox(env, {
    sendEmail: async (payload) => { sent = payload; return { data: { id: 'open-1' } }; },
    getSentEmail: async () => ({ data: { message_id: '<open-1@tagmails.test>' } }),
  })).state, 'sent');
  assert.match(sent.html, /href="https:\/\/tagmails\.example\/open#claude\/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"[^>]*>Open in Claude</);
  assert.doesNotMatch(sent.text, /Transcript/);
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
  // The answer leads; there is no generic heading.
  assert.match(payload.text, /^I created report\.txt\./);
  assert.match(payload.text, /Verify local file changes before relying on them\./);
  assert.doesNotMatch(payload.html, /<h1>/);
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
  assert.match(payload.text, /^The requested file is outside the selected workspace\./);
  assert.match(payload.text, /Needs approval/);
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

  await queuedTurn(fixture, { number: 2, from: 'owner@gmail.com', to: ['agent@wonder.test'], threadId: 'thread-2' });
  let sends = 0;
  const first = await sendNextOutbox(env, {
    sendEmail: async () => { sends += 1; return { data: { id: 'sent-2' } }; },
    getSentEmail: async () => ({ error: { message: 'Temporarily unavailable' } }),
  });
  assert.deepEqual(first, { state: 'accepted', jobId: 'job-2' });
  sqlite.prepare("UPDATE outbox SET updated_at = datetime('now', '-2 minutes') WHERE job_id = ?")
    .run('job-2');
  assert.deepEqual(await sendNextOutbox(env, {
    sendEmail: async () => { throw new Error('Must not send again'); },
    getSentEmail: async () => ({ data: { message_id: '<sent-2@tagmails.test>' } }),
  }), { state: 'sent', jobId: 'job-2', messageId: '<sent-2@tagmails.test>' });
  assert.equal(sends, 1);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM messages WHERE direction = 'outbound'").get().n, 1);
});

test('accepted lookup delays one thread while other threads send and reply order stays intact', async () => {
  const fixture = bindings();
  const { env, sqlite } = fixture;
  await queuedTurn(fixture, { number: 1, from: 'owner@gmail.com', to: ['agent@wonder.test'], jobId: 'z-first' });
  await queuedTurn(fixture, { number: 2, from: 'owner@gmail.com', to: ['agent@wonder.test'],
    inReplyTo: '<inbound-1@gmail.com>', jobId: 'a-second' });
  await queuedTurn(fixture, { number: 3, from: 'owner@gmail.com', to: ['agent@wonder.test'],
    threadId: 'thread-2', jobId: 'm-independent' });
  const sent = [];
  const provider = {
    sendEmail: async (payload) => {
      const jobId = payload.tags[0].value;
      sent.push(jobId);
      return { data: { id: `provider-${jobId}` } };
    },
    getSentEmail: async (id) => id === 'provider-z-first'
      ? { error: { message: 'Message-ID unavailable' } }
      : { data: { message_id: `<${id}@tagmails.test>` } },
  };
  assert.deepEqual(await sendNextOutbox(env, provider), { state: 'accepted', jobId: 'z-first' });
  assert.deepEqual(await sendNextOutbox(env, provider), {
    state: 'sent', jobId: 'm-independent', messageId: '<provider-m-independent@tagmails.test>',
  });
  assert.deepEqual(sent, ['z-first', 'm-independent']);
  assert.equal((await sendNextOutbox(env, provider)).state, 'idle');
  sqlite.prepare("UPDATE outbox SET updated_at = datetime('now', '-2 minutes') WHERE job_id = ?")
    .run('z-first');
  assert.deepEqual(await sendNextOutbox(env, provider), { state: 'accepted', jobId: 'z-first' });
  assert.deepEqual(await sendNextOutbox(env, provider), { state: 'idle' });
  assert.deepEqual(sent, ['z-first', 'm-independent']);
  sqlite.prepare("UPDATE outbox SET updated_at = datetime('now', '-2 minutes') WHERE job_id = ?")
    .run('z-first');
  provider.getSentEmail = async (id) => ({ data: { message_id: `<${id}@tagmails.test>` } });
  assert.deepEqual(await sendNextOutbox(env, provider), {
    state: 'sent', jobId: 'z-first', messageId: '<provider-z-first@tagmails.test>',
  });
  assert.deepEqual(await sendNextOutbox(env, provider), {
    state: 'sent', jobId: 'a-second', messageId: '<provider-a-second@tagmails.test>',
  });
  assert.deepEqual(sent, ['z-first', 'm-independent', 'a-second']);
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

test('an early sent event supports immediate reaction and reply without a second send', async () => {
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
      assert.deepEqual(await reaction(env, { providerEmailId: 'early-reaction',
        from: 'owner@gmail.com', targetId: '<early@tagmails.test>' }),
      { accepted: true, reaction: true, duplicate: false });
      const followup = await handleInbound(new Request('https://relay.test/webhooks/resend', {
        method: 'POST', body: '{}',
      }), env, { inspect: async () => ({ providerEmailId: 'quick-followup',
        messageId: '<quick-followup@gmail.com>', agentAddress: 'agent@wonder.test',
        from: 'owner@gmail.com', to: ['agent@wonder.test'], cc: [], bcc: [],
        subject: 'Re: Shared work', body: 'Continue this thread.',
        parentIds: ['<early@tagmails.test>'], rawMime: Buffer.from('Synthetic follow-up') }) });
      assert.equal((await followup.json()).accepted, true);
      assert.equal(sqlite.prepare('SELECT thread_id FROM messages WHERE message_id = ?')
        .get('<quick-followup@gmail.com>').thread_id, 'thread-1');
      return { data: { id: providerId } };
    },
  });
  assert.deepEqual(first, { state: 'accepted', jobId });
  assert.deepEqual(await sendNextOutbox(env, {
    sendEmail: async () => { throw new Error('Must not send twice'); },
    getSentEmail: async () => ({ data: { message_id: '<early@tagmails.test>' } }),
  }), { state: 'sent', jobId, messageId: '<early@tagmails.test>' });
  assert.equal(sqlite.prepare("SELECT count(*) n FROM messages WHERE direction = 'outbound'").get().n, 1);
  const event = { jobId, providerEmailId: providerId, messageId: '<early@tagmails.test>',
    from: 'agent@wonder.test', to: ['owner@gmail.com'], cc: [], subject: 'Re: Shared work' };
  assert.deepEqual(await reconcileSentEvent(env, event), { accepted: true, duplicate: true });
  assert.deepEqual(await reconcileSentEvent(env, { ...event, messageId: '<wrong@tagmails.test>' }),
    { accepted: false, duplicate: true });
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
  await queuedTurn(fixture, { number: 1, from: 'owner@gmail.com', to: ['agent@wonder.test'],
    cc: ['reviewer@gmail.com'], jobId: receiptJobId });
  sqlite.prepare('INSERT INTO participants (thread_id, email) VALUES (?, ?)').run('thread-1', 'reviewer@gmail.com');
  const payloads = [];
  const provider = {
    sendEmail: async (payload) => { payloads.push(payload); return { data: { id: `sent-${payloads.length}` } }; },
    getSentEmail: async (id) => ({ data: { message_id: `<${id}@tagmails.test>` } }),
  };
  assert.equal((await sendNextOutbox(env, provider)).state, 'sent');
  assert.ok(payloads[0].html.includes(`https://site.tagmails.test/run?id=${receiptJobId}`));
  assert.match(payloads[0].text, /Transcript \(owner only\)/);
  assert.doesNotMatch(payloads[0].html, /relay\.tagmails\.test\/runs/);
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

test('owner-only replies show remaining test credits without exposing them to guests', async () => {
  const fixture = bindings();
  const { env, sqlite } = fixture;
  env.BILLING_TEST_MODE = 'true';
  env.STRIPE_SECRET_KEY = 'sk_test_fixture';
  env.STRIPE_WEBHOOK_SECRET = 'whsec_fixture';
  sqlite.prepare(`INSERT INTO billing_checkouts (id, account_id, amount_cents)
    VALUES ('checkout-1', 'account-1', 1000)`).run();
  sqlite.prepare(`INSERT INTO credit_ledger (id, account_id, checkout_id, amount_cents, kind, source_id)
    VALUES ('credit-1', 'account-1', 'checkout-1', 1000, 'test_top_up', 'session-1')`).run();
  await queuedTurn(fixture, { number: 1, from: 'owner@gmail.com', to: ['agent@wonder.test'] });
  const allowance = { observedAt: Date.now(), windows: [{ durationMins: 10080,
    remainingPercent: 66, resetsAt: Math.floor(Date.now() / 1000) + 86400 }] };
  await env.MAIL.put('results/1.json', JSON.stringify({ state: 'completed', summary: 'Turn 1 finished.',
    runtime: 'codex-app-server-readonly', codexAllowance: allowance }));
  sqlite.prepare(`INSERT INTO test_email_charges (job_id, account_id, amount_cents, state)
    VALUES ('job-1', 'account-1', 5, 'reserved')`).run();
  const payloads = [];
  const provider = {
    sendEmail: async (payload) => { payloads.push(payload); return { data: { id: `sent-${payloads.length}` } }; },
    getSentEmail: async (id) => ({ data: { message_id: `<${id}@tagmails.test>` } }),
  };
  assert.equal((await sendNextOutbox(env, provider)).state, 'sent');
  assert.match(payloads[0].text, /Balance \$9\.95/);
  assert.match(payloads[0].html, /Balance \$9\.95/);
  assert.match(payloads[0].text, /Codex 66% \(7-day\)/);

  sqlite.prepare('INSERT INTO participants (thread_id, email) VALUES (?, ?)').run('thread-1', 'reviewer@gmail.com');
  await queuedTurn(fixture, { number: 2, from: 'reviewer@gmail.com',
    to: ['agent@wonder.test', 'owner@gmail.com'] });
  await env.MAIL.put('results/2.json', JSON.stringify({ state: 'completed', summary: 'Turn 2 finished.',
    runtime: 'codex-app-server-readonly', codexAllowance: allowance }));
  assert.equal((await sendNextOutbox(env, provider)).state, 'sent');
  assert.deepEqual(payloads[1].cc, ['owner@gmail.com']);
  assert.doesNotMatch(payloads[1].text, /credits remaining/);
  assert.doesNotMatch(payloads[1].html, /credits remaining/);
  assert.doesNotMatch(payloads[1].text, /Codex plan/);
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

test('small output files attach only to an owner-only reply, with exact saved bytes', async () => {
  const fixture = bindings();
  const { env, sqlite } = fixture;
  env.SITE_ORIGIN = 'https://tagmails.example';
  const fileId = '11111111-1111-4111-8111-111111111111';
  const bytes = Buffer.from('TagMails pilot workspace\n');
  await queuedTurn(fixture, { number: 1, from: 'owner@gmail.com', to: ['agent@wonder.test'] });
  sqlite.prepare(`INSERT INTO run_artifacts
    (id, account_id, job_id, lease_id, object_key, name, mime_type, byte_size)
    VALUES (?, 'account-1', 'job-1', 'lease-1', 'files/status', 'status.txt', 'text/plain', ?)`)
    .run(fileId, bytes.length);
  await env.MAIL.put('files/status', bytes);
  await env.MAIL.put('results/1.json', JSON.stringify({ state: 'completed', summary: 'File ready.', artifactIds: [fileId] }));
  let sent;
  let sends = 0;
  const provider = { sendEmail: async (payload) => { sent = payload; return { data: { id: `attached-${++sends}` } }; },
    getSentEmail: async (id) => ({ data: { message_id: `<${id}@tagmails.test>` } }) };
  assert.equal((await sendNextOutbox(env, provider)).state, 'sent');
  assert.deepEqual(sent.attachments, [{ filename: 'status.txt', contentType: 'text/plain', content: bytes.toString('base64') }]);
  assert.doesNotMatch(sent.text, /file attached/);
  assert.doesNotMatch(sent.html, /file attached/);
  assert.match(sent.text, /Transcript/);
  const saved = JSON.parse(sqlite.prepare('SELECT payload_json FROM outbox WHERE job_id = ?').get('job-1').payload_json);
  assert.equal(saved.attachments[0].content, undefined);
  assert.equal(await purgeSettledOutboundBodies(env), 1);
  assert.equal(JSON.parse(sqlite.prepare('SELECT payload_json FROM outbox WHERE job_id = ?').get('job-1').payload_json).attachments, undefined);

  // A shared reply must not carry an owner-only file, even if its result selects that ID.
  sqlite.prepare('INSERT INTO participants (thread_id, email) VALUES (?, ?)').run('thread-1', 'reviewer@gmail.com');
  await queuedTurn(fixture, { number: 2, from: 'owner@gmail.com', to: ['agent@wonder.test', 'reviewer@gmail.com'] });
  await env.MAIL.put('results/2.json', JSON.stringify({ state: 'completed', summary: 'Shared answer.', artifactIds: [fileId] }));
  assert.equal((await sendNextOutbox(env, provider)).state, 'sent');
  assert.equal(sent.attachments, undefined);
});

test('archives, large, expired, and different-job files are never attached to an email', async () => {
  const fixture = bindings();
  const { env, sqlite } = fixture;
  env.SITE_ORIGIN = 'https://tagmails.example';
  await queuedTurn(fixture, { number: 1, from: 'owner@gmail.com', to: ['agent@wonder.test'] });
  await queuedTurn(fixture, { number: 2, from: 'owner@gmail.com', to: ['agent@wonder.test'] });
  const rows = [
    ['archive-file', 'job-1', 182_014, '2099-01-01', 'scripts.zip'],
    ['large-file', 'job-1', 3_500_001, '2099-01-01'],
    ['expired-file', 'job-1', 10, '2000-01-01'],
    ['different-job', 'job-2', 10, '2099-01-01'],
  ];
  for (const [id, job, size, expiry, name = 'file.txt'] of rows) sqlite.prepare(`INSERT INTO run_artifacts
    (id, account_id, job_id, lease_id, object_key, name, mime_type, byte_size, expires_at)
    VALUES (?, 'account-1', ?, 'lease-1', ?, ?, 'text/plain', ?, ?)`)
    .run(id, job, `files/${id}`, name, size, expiry);
  await env.MAIL.put('results/1.json', JSON.stringify({ state: 'completed', summary: 'Files ready.', artifactIds: rows.map(([id]) => id) }));
  let sent;
  assert.equal((await sendNextOutbox(env, { sendEmail: async (payload) => { sent = payload; return { data: { id: 'large-1' } }; },
    getSentEmail: async () => ({ data: { message_id: '<large-1@tagmails.test>' } }) })).state, 'sent');
  assert.equal(sent.attachments, undefined);
  assert.match(sent.text, /2 files · 7 days/);
  assert.match(sent.text, /Transcript/);
});

test('changed attachment bytes block the reply before a provider send', async () => {
  const fixture = bindings();
  const { env, sqlite } = fixture;
  await queuedTurn(fixture, { number: 1, from: 'owner@gmail.com', to: ['agent@wonder.test'] });
  sqlite.prepare(`INSERT INTO run_artifacts
    (id, account_id, job_id, lease_id, object_key, name, mime_type, byte_size, sha256)
    VALUES ('changed-file', 'account-1', 'job-1', 'lease-1', 'files/changed', 'file.txt', 'text/plain', 4, ?)`)
    .run('0'.repeat(64));
  await env.MAIL.put('files/changed', Buffer.from('oops'));
  await env.MAIL.put('results/1.json', JSON.stringify({ state: 'completed', summary: 'Ready.', artifactIds: ['changed-file'] }));
  let sent = false;
  assert.equal((await sendNextOutbox(env, { sendEmail: async () => { sent = true; } })).state, 'blocked');
  assert.equal(sent, false);
});
