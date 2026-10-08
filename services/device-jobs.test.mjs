import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { handleDeviceRequest } from './device-jobs.mjs';
import { completeOneModelClarification, handleInbound } from './relay-worker.mjs';
import { bindings } from './bindings-fixture.mjs';
import { handleAccountRequest } from './account-auth.mjs';
import { deleteExpiredRunArtifacts } from './run-artifacts.mjs';
import { sendNextOutbox } from './outbox.mjs';
import { sendNextStatusReaction } from './status-reactions.mjs';

function device(sqlite, accountId = 'account-1') {
  const token = `tm_dev_${randomBytes(32).toString('base64url')}`;
  const id = `device-${randomBytes(4).toString('hex')}`;
  const hash = createHash('sha256').update(token).digest('hex');
  sqlite.prepare('INSERT INTO devices (id, account_id, token_hash) VALUES (?, ?, ?)').run(id, accountId, hash);
  return { id, token };
}

function envelope(body) { return JSON.parse(Buffer.from(body.payload, 'base64url').toString('utf8')); }

async function inbound(env, id = 'email-1', body = 'Model: Luna\nRead the status without changing files.', parentIds = [],
  expected = { accepted: true, duplicate: false }) {
  const messageId = `<${id}@gmail.com>`;
  const rawMime = Buffer.from([
    'From: owner@gmail.com', 'To: agent@wonder.test', 'Subject: Check routing',
    `Message-ID: ${messageId}`, ...(parentIds.length ? [`References: ${parentIds.join(' ')}`] : []),
    'Content-Type: text/plain; charset=utf-8', '',
    body,
  ].join('\r\n'));
  const message = {
    providerEmailId: id, messageId, from: 'owner@gmail.com', agentAddress: 'agent@wonder.test', to: ['agent@wonder.test'],
    cc: [], bcc: [], subject: 'Check routing', parentIds, rawMime, body,
  };
  const response = await handleInbound(new Request('https://relay.test/webhooks/resend', { method: 'POST', body: '{}' }), env, {
    inspect: async () => message,
  });
  assert.deepEqual(await response.json(), expected);
}

async function call(env, token, path, body) {
  const response = await handleDeviceRequest(new Request(`https://relay.test/api/device/${path}`, {
    method: 'POST', headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  return { status: response.status, body: await response.json() };
}

test('queued mail keeps its selected default after the account preference changes', async () => {
  const { env, sqlite } = bindings();
  const paired = device(sqlite);
  sqlite.prepare('UPDATE accounts SET default_model = ? WHERE id = ?').run('claude-sonnet-5-5', 'account-1');
  await inbound(env, 'default-first', 'Review the note.');
  assert.deepEqual(JSON.parse(sqlite.prepare('SELECT model_json FROM jobs').get().model_json),
    { id: 'claude-sonnet-5-5', effort: 'medium', source: 'default' });
  sqlite.prepare('UPDATE accounts SET default_model = ? WHERE id = ?').run('gpt-6.1-sol', 'account-1');
  const first = await call(env, paired.token, 'claim');
  assert.deepEqual(envelope(first.body).model,
    { id: 'claude-sonnet-5-5', effort: 'medium', source: 'default' });
  await inbound(env, 'explicit-second', 'Model: Luna\nReview the note.');
  const second = await call(env, paired.token, 'claim');
  assert.deepEqual(envelope(second.body).model,
    { id: 'gpt-6-luna', effort: 'medium', source: 'explicit' });
});

test('a queued message stays claimable after the account address changes', async () => {
  const { env, sqlite } = bindings();
  const paired = device(sqlite);
  await inbound(env, 'before-domain-move');
  assert.equal(sqlite.prepare('SELECT agent_email FROM messages').get().agent_email, 'agent@wonder.test');
  sqlite.prepare('UPDATE accounts SET agent_email = ? WHERE id = ?').run('agent@tagmails.test', 'account-1');
  const claim = await call(env, paired.token, 'claim');
  assert.equal(claim.status, 200);
  assert.equal(claim.body.claimed, true);
  assert.match(envelope(claim.body).request.body, /Read the status/);
});

test('replies inherit the original route without reclassifying quoted model lines', async () => {
  const { env, sqlite } = bindings();
  sqlite.prepare('UPDATE accounts SET default_model = ? WHERE id = ?').run('claude-sonnet-5-5', 'account-1');
  await inbound(env, 'original-route', 'Model: Luna\nDraft the review.');
  await inbound(env, 'quoted-route', 'Please review this.\n\nOn Friday, Alex wrote:\nModel: Luna',
    ['<original-route@gmail.com>']);
  const jobs = sqlite.prepare(`SELECT j.thread_id, j.model_json FROM jobs j
    JOIN messages m ON m.id = j.message_id ORDER BY m.provider_email_id`).all();
  assert.equal(jobs[0].thread_id, jobs[1].thread_id);
  assert.deepEqual(JSON.parse(jobs[1].model_json),
    { id: 'gpt-6-luna', effort: 'medium', source: 'thread' });
});

test('a paired device receives a signed, account-scoped claim and completes it once', async () => {
  const { env, sqlite, objects } = bindings();
  const paired = device(sqlite);
  await inbound(env);
  assert.equal((await call(env, 'wrong-token', 'claim')).status, 401);
  const { status, body } = await call(env, paired.token, 'claim');
  assert.equal(status, 200);
  assert.equal(body.claimed, true);
  const signedJob = envelope(body);
  assert.deepEqual(signedJob.model, { id: 'gpt-6-luna', effort: 'medium', source: 'explicit' });
  assert.equal(signedJob.request.from, 'owner@gmail.com');
  assert.equal(signedJob.request.fromOwner, true);
  assert.match(signedJob.request.body, /Read the status/);
  assert.equal(body.signature, createHmac('sha256', paired.token).update(Buffer.from(body.payload, 'base64url')).digest('base64url'));
  assert.deepEqual((await call(env, paired.token, 'claim')).body, { claimed: false });

  const lease = { jobId: signedJob.jobId, leaseId: signedJob.leaseId };
  assert.equal((await call(env, paired.token, 'renew', lease)).body.renewed, true);
  const result = { state: 'completed', summary: 'The local agent read the status.',
    transcript: { version: 1, truncated: false, events: [
      { kind: 'request', text: 'Read the status.' },
      { kind: 'reasoning', text: 'I checked the available file.' },
      { kind: 'tool', text: 'Read requested.' },
      { kind: 'assistant', text: 'The local agent read the status. '.repeat(170) }] },
    usage: { inputTokens: 1200, cachedInputTokens: 300, cacheCreationInputTokens: 0,
      outputTokens: 40, reasoningOutputTokens: 12 } };
  assert.equal((await call(env, paired.token, 'complete', { ...lease,
    result: { ...result, usage: { ...result.usage, inputTokens: -1 } } })).status, 400);
  assert.equal((await call(env, paired.token, 'complete', { ...lease,
    result: { ...result, transcript: { ...result.transcript, events: [
      ...result.transcript.events.slice(0, -1), { kind: 'assistant', text: 'x'.repeat(8001) }] } } })).status, 400);
  assert.deepEqual(await call(env, paired.token, 'complete', { ...lease, result }), {
    status: 200, body: { completed: true, duplicate: false },
  });
  assert.deepEqual(await call(env, paired.token, 'complete', { ...lease, result }), {
    status: 200, body: { completed: true, duplicate: true },
  });
  assert.equal((await call(env, paired.token, 'complete', { ...lease, result: { ...result, summary: 'Different' } })).status, 409);
  const job = sqlite.prepare('SELECT state, result_key FROM jobs').get();
  assert.equal(job.state, 'completed');
  assert.equal(sqlite.prepare('SELECT job_id FROM outbox').get().job_id, signedJob.jobId);
  assert.equal(sqlite.prepare('SELECT state FROM outbox').get().state, 'queued');
  assert.equal(JSON.parse(objects.get(job.result_key).toString()).summary, result.summary);
  assert.deepEqual(JSON.parse(objects.get(job.result_key).toString()).transcript, result.transcript);
});

test('a Gmail owner receives one ordered status reaction per durable task stage', async () => {
  const { env, sqlite } = bindings();
  env.STATUS_REACTIONS_ENABLED = 'true';
  const paired = device(sqlite);
  await inbound(env, 'status-turn');
  const signedJob = envelope((await call(env, paired.token, 'claim')).body);
  const lease = { jobId: signedJob.jobId, leaseId: signedJob.leaseId };
  assert.equal((await call(env, paired.token, 'started', { ...lease, leaseId: 'wrong' })).status, 409);
  assert.deepEqual((await call(env, paired.token, 'started', lease)).body, { started: true });
  assert.deepEqual((await call(env, paired.token, 'started', lease)).body, { started: true });
  assert.equal((await call(env, paired.token, 'complete', { ...lease,
    result: { runtime: 'codex-app-server-readonly', state: 'completed', summary: 'Done.' } })).status, 200);
  const sent = [];
  const send = async (message) => { sent.push(message.raw); return { accepted: true }; };
  for (const status of ['received', 'completed']) {
    assert.deepEqual(await sendNextStatusReaction(env, { send }),
      { state: 'accepted', jobId: signedJob.jobId, status });
  }
  assert.equal((await sendNextStatusReaction(env, { send })).state, 'idle');
  assert.deepEqual(sqlite.prepare('SELECT status, state FROM status_reactions ORDER BY rowid').all().map((row) => ({ ...row })),
    ['received', 'completed'].map((status) => ({ status, state: 'accepted' })));
  assert.ok(sent[0].includes(`In-Reply-To: <status-turn@gmail.com>`));
  assert.equal(sent.length, 2);
});

test('same-thread turns wait and stay with the Mac that owns their local session', async () => {
  const { env, sqlite } = bindings();
  const firstDevice = device(sqlite);
  const otherDevice = device(sqlite);
  await inbound(env, 'turn-one');
  await inbound(env, 'turn-two', 'Continue the task.', ['<turn-one@gmail.com>']);
  const first = envelope((await call(env, firstDevice.token, 'claim')).body);
  assert.equal(sqlite.prepare('SELECT device_id FROM threads WHERE id = ?').get(first.threadId).device_id, firstDevice.id);
  assert.deepEqual((await call(env, otherDevice.token, 'claim')).body, { claimed: false });
  assert.deepEqual((await call(env, firstDevice.token, 'claim')).body, { claimed: false });
  assert.equal((await call(env, firstDevice.token, 'complete', {
    jobId: first.jobId, leaseId: first.leaseId,
    result: { state: 'completed', summary: 'First turn finished.' },
  })).status, 200);
  assert.deepEqual((await call(env, otherDevice.token, 'claim')).body, { claimed: false });
  const second = envelope((await call(env, firstDevice.token, 'claim')).body);
  assert.equal(second.threadId, first.threadId);
  assert.notEqual(second.jobId, first.jobId);
  assert.equal(second.request.body, 'Continue the task.');
  await inbound(env, 'other-thread');
  const independent = envelope((await call(env, otherDevice.token, 'claim')).body);
  assert.notEqual(independent.threadId, first.threadId);
});

test('a reply to a revoked Mac gets a relay explanation without running or charging', async () => {
  const { env, sqlite } = bindings();
  const firstDevice = device(sqlite);
  const otherDevice = device(sqlite);
  await inbound(env);
  const first = envelope((await call(env, firstDevice.token, 'claim')).body);
  assert.equal((await call(env, firstDevice.token, 'complete', {
    jobId: first.jobId, leaseId: first.leaseId,
    result: { state: 'completed', summary: 'First turn finished.' },
  })).status, 200);
  assert.equal((await sendNextOutbox(env, {
    sendEmail: async () => ({ data: { id: 'first-send' } }),
    getSentEmail: async () => ({ data: { message_id: '<first-send@tagmails.test>' } }),
  })).state, 'sent');
  sqlite.prepare('UPDATE devices SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?').run(firstDevice.id);
  await inbound(env, 'after-revoke', 'Continue the same task.', ['<email-1@gmail.com>'],
    { accepted: true, duplicate: false, threadUnavailable: true });
  const stopped = sqlite.prepare(`SELECT j.state, j.model_json, j.result_key FROM jobs j
    JOIN messages m ON m.id = j.message_id WHERE m.provider_email_id = ?`).get('after-revoke');
  assert.equal(stopped.state, 'failed');
  assert.equal(stopped.model_json, null);
  assert.ok(stopped.result_key);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM test_email_charges').get().n, 0);
  assert.deepEqual((await call(env, otherDevice.token, 'claim')).body, { claimed: false });
  let reply;
  const sent = await sendNextOutbox(env, {
    sendEmail: async (payload) => { reply = payload; return { data: { id: randomUUID() } }; },
    getSentEmail: async () => ({ data: { message_id: '<revoked-reply@tagmails.test>' } }),
  });
  assert.equal(sent.state, 'sent');
  assert.match(reply.text, /Mac was revoked/);
  assert.match(reply.text, /No local agent ran/);
});

test('device status confirms an active token without claiming queued mail', async () => {
  const { env, sqlite } = bindings();
  const paired = device(sqlite);
  await inbound(env);
  const request = (token) => handleDeviceRequest(new Request('https://relay.test/api/device/status', {
    headers: { Authorization: `Bearer ${token}` },
  }), env);
  const active = await request(paired.token);
  assert.equal(active.status, 200);
  assert.deepEqual(await active.json(), { paired: true });
  assert.equal(active.headers.get('cache-control'), 'no-store');
  assert.equal(sqlite.prepare('SELECT state FROM jobs').get().state, 'queued');
  assert.equal(sqlite.prepare('SELECT last_seen_at FROM devices WHERE id = ?').get(paired.id).last_seen_at, null);
  sqlite.prepare('UPDATE devices SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?').run(paired.id);
  assert.equal((await request(paired.token)).status, 401);
});

test('an idle daemon poll records when the paired Mac last contacted the relay', async () => {
  const { env, sqlite } = bindings();
  const paired = device(sqlite);
  assert.deepEqual((await call(env, paired.token, 'claim')).body, { claimed: false });
  const seen = sqlite.prepare('SELECT last_seen_at FROM devices WHERE id = ?').get(paired.id).last_seen_at;
  assert.match(seen, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.deepEqual((await call(env, paired.token, 'claim')).body, { claimed: false });
  assert.equal(sqlite.prepare('SELECT last_seen_at FROM devices WHERE id = ?').get(paired.id).last_seen_at, seen);
});

test('a signed guest claim cannot request the owner-only answer export', async () => {
  const { env, sqlite } = bindings();
  const paired = device(sqlite);
  await inbound(env);
  const owner = envelope((await call(env, paired.token, 'claim')).body);
  assert.equal((await call(env, paired.token, 'complete', { jobId: owner.jobId, leaseId: owner.leaseId,
    result: { state: 'completed', summary: 'Owner turn done.' } })).status, 200);
  sqlite.prepare('INSERT INTO participants (thread_id, email) VALUES (?, ?)')
    .run(owner.threadId, 'guest@gmail.com');
  const messageId = '<guest-reply@gmail.com>';
  const body = 'TagMails-Attach: answer.txt\nModel: Luna\nSummarize this.';
  const guest = await handleInbound(new Request('https://relay.test/webhooks/resend', {
    method: 'POST', body: '{}',
  }), env, { inspect: async () => ({ providerEmailId: 'guest-reply', messageId,
    from: 'guest@gmail.com', agentAddress: 'agent@wonder.test', to: ['agent@wonder.test'],
    cc: [], bcc: [], subject: 'Re: Check routing', body, parentIds: ['<email-1@gmail.com>'],
    rawMime: Buffer.from(`From: guest@gmail.com\r\nTo: agent@wonder.test\r\nSubject: Re: Check routing\r\nMessage-ID: ${messageId}\r\nReferences: <email-1@gmail.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`),
  }) });
  assert.equal(guest.status, 200);
  const claim = envelope((await call(env, paired.token, 'claim')).body);
  assert.equal(claim.request.from, 'guest@gmail.com');
  assert.equal(claim.request.fromOwner, false);
});

test('expired leases are reclaimed and a stale or different device cannot complete them', async () => {
  const { env, sqlite } = bindings();
  const firstDevice = device(sqlite);
  const secondDevice = device(sqlite);
  await inbound(env);
  const first = envelope((await call(env, firstDevice.token, 'claim')).body);
  sqlite.prepare("UPDATE jobs SET lease_until = datetime('now', '-1 second')").run();
  assert.equal((await call(env, firstDevice.token, 'renew', { jobId: first.jobId, leaseId: first.leaseId })).status, 409);
  assert.deepEqual((await call(env, secondDevice.token, 'claim')).body, { claimed: false });
  const second = envelope((await call(env, firstDevice.token, 'claim')).body);
  assert.equal(second.jobId, first.jobId);
  assert.notEqual(second.leaseId, first.leaseId);
  const result = { state: 'completed', summary: 'Finished after recovery.' };
  assert.equal((await call(env, firstDevice.token, 'complete', { jobId: first.jobId, leaseId: first.leaseId, result })).status, 409);
  assert.equal((await call(env, secondDevice.token, 'complete', { jobId: second.jobId, leaseId: second.leaseId, result })).status, 404);
  assert.equal((await call(env, firstDevice.token, 'complete', { jobId: second.jobId, leaseId: second.leaseId, result })).status, 200);
  assert.equal(sqlite.prepare('SELECT attempts FROM jobs').get().attempts, 2);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM outbox').get().n, 1);
});

test('a 24 MB MIME attachment stays out of the claim and requires its active device lease', async () => {
  const { env, sqlite } = bindings();
  const paired = device(sqlite);
  const stranger = device(sqlite);
  const contents = Buffer.alloc(24_000_000, 0x61);
  const rawMime = Buffer.from([
    'From: owner@gmail.com', 'To: agent@wonder.test', 'Subject: Large input',
    'Message-ID: <large-input@gmail.com>', 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="large"', '',
    '--large', 'Content-Type: text/plain', '', 'Inspect the attached file.',
    '--large', 'Content-Type: application/octet-stream',
    'Content-Disposition: attachment; filename="input.bin"',
    'Content-Transfer-Encoding: base64', '', contents.toString('base64'), '--large--', '',
  ].join('\r\n'));
  const response = await handleInbound(new Request('https://relay.test/webhooks/resend', { method: 'POST', body: '{}' }), env, {
    inspect: async () => ({ providerEmailId: 'large-input', messageId: '<large-input@gmail.com>',
      from: 'owner@gmail.com', agentAddress: 'agent@wonder.test', to: ['agent@wonder.test'],
      cc: [], bcc: [], subject: 'Large input', body: 'Inspect the attached file.', parentIds: [], rawMime }),
  });
  assert.equal(response.status, 200);
  sqlite.prepare('UPDATE accounts SET agent_email = ? WHERE id = ?').run('agent@tagmails.test', 'account-1');
  const lease = envelope((await call(env, paired.token, 'claim')).body);
  assert.ok(JSON.stringify(lease).length < 2_000);
  assert.equal(lease.request.attachments[0].size, contents.length);
  assert.equal(lease.request.attachments[0].data, undefined);
  const url = `https://relay.test${lease.request.attachments[0].path}`;
  const get = (token) => handleDeviceRequest(new Request(url, {
    headers: { Authorization: `Bearer ${token}` },
  }), env);
  assert.equal((await get(stranger.token)).status, 409);
  assert.equal((await get('wrong-token')).status, 401);
  const file = await get(paired.token);
  assert.equal(file.status, 200);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), contents);
  assert.equal((await call(env, paired.token, 'complete', { jobId: lease.jobId, leaseId: lease.leaseId,
    result: { state: 'completed', summary: 'I read the attached input.' } })).status, 200);
  const sent = await sendNextOutbox(env, {
    sendEmail: async (payload) => {
      assert.equal(payload.from, 'agent@tagmails.test');
      assert.equal(payload.to[0], 'owner@gmail.com');
      assert.match(payload.text, /I read the attached input/);
      return { data: { id: randomUUID() } };
    },
    getSentEmail: async () => ({ data: { message_id: '<large-reply@resend.dev>' } }),
  });
  assert.equal(sent.state, 'sent');
  assert.equal((await get(paired.token)).status, 409);
});

test('a run file is uploaded under its lease, privately downloaded, and deleted after seven days', async () => {
  const { env, sqlite, objects } = bindings();
  env.SITE_ORIGIN = 'https://tagmails.chatgpt.site';
  const paired = device(sqlite);
  await inbound(env);
  const lease = envelope((await call(env, paired.token, 'claim')).body);
  const upload = (token, length = 4) => handleDeviceRequest(new Request(
    `https://relay.test/api/device/artifacts?jobId=${lease.jobId}&leaseId=${lease.leaseId}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'video/mp4',
        'Content-Length': String(length), 'X-TagMails-Filename': encodeURIComponent('demo clip.mp4') },
      body: Buffer.from('clip'),
    }), env);
  assert.equal((await upload('bad')).status, 401);
  assert.equal((await upload(paired.token, 24_000_001)).status, 413);
  const saved = await upload(paired.token);
  assert.equal(saved.status, 201);
  const file = await saved.json();
  assert.equal(file.name, 'demo clip.mp4');
  assert.equal(file.size, 4);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM run_artifacts').get().n, 1);
  const result = { state: 'completed', summary: 'The file is ready.', artifactIds: [file.id] };
  assert.equal((await call(env, paired.token, 'complete', { jobId: lease.jobId, leaseId: lease.leaseId,
    result: { ...result, artifactIds: [randomUUID()] } })).status, 400);
  assert.equal((await call(env, paired.token, 'complete', { jobId: lease.jobId, leaseId: lease.leaseId,
    result })).status, 200);

  const identity = { verifyIdentity: async (credential) => {
    if (credential !== 'owner-token') throw new Error('Bad token');
    return { sub: 'google-sub-1', email: 'owner@gmail.com' };
  } };
  const headers = { Authorization: 'Bearer owner-token', Origin: env.SITE_ORIGIN };
  const run = await handleAccountRequest(new Request(`https://relay.test/api/runs/${lease.jobId}`, { headers }), env, identity);
  assert.deepEqual((await run.json()).artifacts.map(({ id, name, size }) => ({ id, name, size })),
    [{ id: file.id, name: file.name, size: 4 }]);
  const fileUrl = `https://relay.test/api/runs/${lease.jobId}/artifacts/${file.id}`;
  assert.equal((await handleAccountRequest(new Request(fileUrl), env, identity)).status, 401);
  assert.equal((await handleAccountRequest(new Request(fileUrl, { headers }), env, {
    verifyIdentity: async () => ({ sub: 'unknown-user', email: 'other@gmail.com' }),
  })).status, 404);
  const downloaded = await handleAccountRequest(new Request(fileUrl, { headers }), env, identity);
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get('content-type'), 'application/octet-stream');
  assert.equal(downloaded.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await downloaded.text(), 'clip');

  const objectKey = sqlite.prepare('SELECT object_key FROM run_artifacts WHERE id = ?').get(file.id).object_key;
  sqlite.prepare("UPDATE run_artifacts SET expires_at = datetime('now', '-1 second') WHERE id = ?").run(file.id);
  assert.equal((await handleAccountRequest(new Request(fileUrl, { headers }), env, identity)).status, 404);
  await deleteExpiredRunArtifacts(env);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM run_artifacts').get().n, 0);
  assert.equal(objects.has(objectKey), false);
});

test('run file uploads accept the 24 MB boundary and enforce the combined limit', async () => {
  const { env, sqlite } = bindings();
  const paired = device(sqlite);
  await inbound(env);
  const lease = envelope((await call(env, paired.token, 'claim')).body);
  const upload = async (bytes) => handleDeviceRequest(new Request(
    `https://relay.test/api/device/artifacts?jobId=${lease.jobId}&leaseId=${lease.leaseId}`, {
      method: 'POST', headers: { Authorization: `Bearer ${paired.token}`,
        'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length),
        'X-TagMails-Filename': 'output.bin' }, body: bytes,
    }), env);
  assert.equal((await upload(Buffer.alloc(24_000_000))).status, 201);
  assert.equal((await upload(Buffer.alloc(1_000_000))).status, 201);
  assert.equal((await upload(Buffer.from('x'))).status, 409);
  assert.equal(sqlite.prepare('SELECT SUM(byte_size) n FROM run_artifacts').get().n, 25_000_000);
});

test('a retried run file upload reuses its ID and rejects changed bytes or metadata', async () => {
  const { env, sqlite, objects } = bindings();
  const paired = device(sqlite);
  await inbound(env);
  const lease = envelope((await call(env, paired.token, 'claim')).body);
  const uploadId = randomUUID();
  const upload = (bytes = 'clip', name = 'clip.mp4', id = uploadId) => handleDeviceRequest(new Request(
    `https://relay.test/api/device/artifacts?jobId=${lease.jobId}&leaseId=${lease.leaseId}`, {
      method: 'POST', headers: { Authorization: `Bearer ${paired.token}`, 'Content-Type': 'video/mp4',
        'Content-Length': String(Buffer.byteLength(bytes)), 'X-TagMails-Filename': encodeURIComponent(name),
        'X-TagMails-Upload-Id': id }, body: Buffer.from(bytes),
    }), env);
  assert.equal((await upload('clip', 'clip.mp4', 'bad-id')).status, 400);
  const [first, retried] = await Promise.all([upload(), upload()]);
  assert.deepEqual([first.status, retried.status].sort(), [200, 201]);
  assert.equal((await first.json()).id, uploadId);
  assert.equal((await retried.json()).id, uploadId);
  assert.equal((await upload()).status, 200);
  assert.equal((await upload('evil')).status, 409);
  assert.equal((await upload('clip', 'other.mp4')).status, 409);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM run_artifacts').get().n, 1);
  assert.equal(objects.size, 2); // One inbound MIME and one winning file object.
  assert.equal(sqlite.prepare('SELECT sha256 FROM run_artifacts WHERE id = ?').get(uploadId).sha256.length, 64);
});

test('a device cannot claim another account and revocation blocks access', async () => {
  const { env, sqlite } = bindings();
  sqlite.prepare('INSERT INTO accounts (id, google_sub, owner_email, agent_email) VALUES (?, ?, ?, ?)')
    .run('account-2', 'google-sub-2', 'other@gmail.com', 'other@wonder.test');
  const other = device(sqlite, 'account-2');
  await inbound(env);
  assert.deepEqual((await call(env, other.token, 'claim')).body, { claimed: false });
  sqlite.prepare('UPDATE devices SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?').run(other.id);
  assert.equal((await call(env, other.token, 'claim')).status, 401);
});

test('a revoked participant email cannot be claimed even if its job remains queued', async () => {
  const { env, sqlite } = bindings();
  const paired = device(sqlite);
  await inbound(env);
  const threadId = sqlite.prepare('SELECT id FROM threads').get().id;
  sqlite.prepare("UPDATE jobs SET state = 'completed'").run();
  sqlite.prepare('INSERT INTO participants (thread_id, email, revoked_at) VALUES (?, ?, CURRENT_TIMESTAMP)')
    .run(threadId, 'guest@gmail.com');
  sqlite.prepare(`INSERT INTO messages (id, account_id, thread_id, message_id, direction, sender_email, object_key)
    VALUES (?, 'account-1', ?, ?, 'inbound', 'guest@gmail.com', ?)`).run('revoked-message', threadId, '<revoked@gmail.com>', 'inbound/revoked.eml');
  sqlite.prepare("INSERT INTO jobs (id, thread_id, message_id, state) VALUES ('revoked-job', ?, 'revoked-message', 'queued')").run(threadId);
  assert.deepEqual((await call(env, paired.token, 'claim')).body, { claimed: false });
});

test('a reply after a relay-only answer also hands the agent the original request', async () => {
  const { env, sqlite } = bindings();
  const paired = device(sqlite);
  await inbound(env, 'unrun-1', 'Model: Gemini Ultra\nWrite travel guide scripts for Madrid and Paris.');
  assert.equal(await completeOneModelClarification(env), true);
  assert.equal((await call(env, paired.token, 'claim')).body.claimed, false);
  await inbound(env, 'unrun-2', 'try now?\n\nOn Mon, TagMails wrote:\n> That model is unavailable.', ['<unrun-1@gmail.com>']);
  const claim = envelope((await call(env, paired.token, 'claim')).body);
  assert.match(claim.request.body, /owner@gmail\.com wrote \(the relay replied without running an agent\):\nModel: Gemini Ultra\nWrite travel guide scripts for Madrid and Paris\./);
  assert.match(claim.request.body, /The current message:\ntry now\?/);
  // Once a completed turn carried it, later turns don't repeat it.
  const lease = { jobId: claim.jobId, leaseId: claim.leaseId };
  await call(env, paired.token, 'complete', { ...lease, result: { runtime: 'codex-app-server-readonly', state: 'completed', summary: 'Done.' } });
  await inbound(env, 'unrun-3', 'Now do Tokyo too.', ['<unrun-1@gmail.com>', '<unrun-2@gmail.com>']);
  const next = envelope((await call(env, paired.token, 'claim')).body);
  assert.equal(next.request.body, 'Now do Tokyo too.');
});

test('a follow-up classified as steering rides the run, and queues if the run ends first', async () => {
  const { env, sqlite } = bindings();
  env.TYPESAFE_API_KEY = 'test-key';
  const paired = device(sqlite);
  const jev = (choice) => async () => Response.json({ answers: { route: { type: 'choice', choice, probabilities: { [choice]: 0.95 } } } });
  const send = async (id, body, parentIds, choice) => {
    const messageId = `<${id}@gmail.com>`;
    const rawMime = Buffer.from(['From: owner@gmail.com', 'To: agent@wonder.test', 'Subject: Trip',
      `Message-ID: ${messageId}`, ...(parentIds.length ? [`References: ${parentIds.join(' ')}`] : []),
      'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n'));
    const message = { providerEmailId: id, messageId, from: 'owner@gmail.com', agentAddress: 'agent@wonder.test',
      to: ['agent@wonder.test'], cc: [], bcc: [], subject: 'Trip', parentIds, rawMime, body, attachments: [] };
    return (await handleInbound(new Request('https://relay.test/webhooks/resend', { method: 'POST', body: '{}' }), env, {
      inspect: async () => message, fetchModel: jev(choice) })).json();
  };
  await send('steer-1', 'Write the japan guide.', [], 'queue');
  const claimed = envelope((await call(env, paired.token, 'claim')).body);
  assert.deepEqual(await send('steer-2', 'make it 10 days', ['<steer-1@gmail.com>'], 'steer'),
    { accepted: true, duplicate: false, steering: true });
  const renewed = await call(env, paired.token, 'renew', { jobId: claimed.jobId, leaseId: claimed.leaseId });
  assert.equal(renewed.body.steers.length, 1);
  assert.equal(renewed.body.steers[0].text, 'make it 10 days');
  const steerId = renewed.body.steers[0].id;
  // A second follow-up the run never takes becomes an ordinary queued job after it completes.
  await send('steer-3', 'also Osaka', ['<steer-1@gmail.com>'], 'steer');
  await call(env, paired.token, 'steered', { jobId: claimed.jobId, leaseId: claimed.leaseId, steerId, delivered: true });
  assert.equal((await call(env, paired.token, 'renew', { jobId: claimed.jobId, leaseId: claimed.leaseId })).body.steers.length, 1);
  assert.equal(sqlite.prepare("SELECT steer_state FROM jobs WHERE id = ?").get(steerId).steer_state, 'delivered');
  const done = await call(env, paired.token, 'complete', { jobId: claimed.jobId, leaseId: claimed.leaseId,
    result: { runtime: 'codex', state: 'completed', summary: 'Done', checks: ['ok'] } });
  assert.equal(done.status, 200);
  const next = await call(env, paired.token, 'claim');
  assert.equal(envelope(next.body).request.body.includes('also Osaka'), true, 'the untaken follow-up runs as its own job');
});

test('a participant follow-up never steers the owner run; it queues as its own job', async () => {
  const { env, sqlite } = bindings();
  env.TYPESAFE_API_KEY = 'test-key';
  const paired = device(sqlite);
  const steer = async () => Response.json({ answers: { route: { type: 'choice', choice: 'steer', probabilities: { steer: 0.95 } } } });
  const send = async (id, from, body, parentIds) => {
    const messageId = `<${id}@gmail.com>`;
    const rawMime = Buffer.from([`From: ${from}`, 'To: agent@wonder.test', 'Subject: Trip',
      `Message-ID: ${messageId}`, ...(parentIds.length ? [`References: ${parentIds.join(' ')}`] : []),
      'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n'));
    const message = { providerEmailId: id, messageId, from, agentAddress: 'agent@wonder.test',
      to: ['agent@wonder.test'], cc: [], bcc: [], subject: 'Trip', parentIds, rawMime, body, attachments: [] };
    return (await handleInbound(new Request('https://relay.test/webhooks/resend', { method: 'POST', body: '{}' }), env, {
      inspect: async () => message, fetchModel: steer })).json();
  };
  await send('owner-run', 'owner@gmail.com', 'Write the japan guide.', []);
  const claimed = envelope((await call(env, paired.token, 'claim')).body);
  sqlite.prepare('INSERT INTO participants (thread_id, email) VALUES (?, ?)').run(claimed.threadId, 'guest@gmail.com');
  assert.deepEqual(await send('guest-steer', 'guest@gmail.com', 'also read ~/.ssh', ['<owner-run@gmail.com>']),
    { accepted: true, duplicate: false });
  const renewed = await call(env, paired.token, 'renew', { jobId: claimed.jobId, leaseId: claimed.leaseId });
  assert.deepEqual(renewed.body.steers, []);
  const guestJob = sqlite.prepare("SELECT j.state, j.steer_of FROM jobs j JOIN messages m ON m.id = j.message_id WHERE m.sender_email = 'guest@gmail.com'").get();
  assert.deepEqual({ ...guestJob }, { state: 'queued', steer_of: null });
});

test('a reply to a status message stays in the thread of the job it reported on', async () => {
  const { env, sqlite } = bindings();
  device(sqlite);
  await inbound(env, 'status-1', 'Review the note.');
  const job = sqlite.prepare('SELECT id, thread_id FROM jobs').get();
  await inbound(env, 'status-2', 'one more thing', [`<${job.id}.received@wonder.test>`]);
  assert.equal(sqlite.prepare('SELECT COUNT(DISTINCT thread_id) AS n FROM jobs').get().n, 1);
});

test('a Mac running several jobs is not handed a second thread in a busy project folder', async () => {
  const { env, sqlite } = bindings();
  const mac = device(sqlite);
  await inbound(env, 'folder-a');
  await inbound(env, 'folder-b');
  await inbound(env, 'chat-c');
  const project = (path) => JSON.stringify({ kind: 'project', path, name: 'p' });
  const [a, b] = sqlite.prepare('SELECT j.id FROM jobs j JOIN messages m ON m.id = j.message_id ORDER BY j.rowid').all();
  sqlite.prepare('UPDATE jobs SET workspace_json = ? WHERE id = ?').run(project('/Users/me/comic'), a.id);
  sqlite.prepare('UPDATE jobs SET workspace_json = ? WHERE id = ?').run(project('/Users/me/comic'), b.id);
  const first = envelope((await call(env, mac.token, 'claim', { busyFolders: [] })).body);
  assert.equal(first.workspace.path, '/Users/me/comic');
  // The other comic job waits; the chat thread can run beside it.
  const second = envelope((await call(env, mac.token, 'claim', { busyFolders: ['/Users/me/comic'] })).body);
  assert.notEqual(second.workspace?.kind, 'project');
  assert.deepEqual((await call(env, mac.token, 'claim', { busyFolders: ['/Users/me/comic'] })).body, { claimed: false });
  // An older daemon sends no list and still gets the queued job.
  assert.equal(envelope((await call(env, mac.token, 'claim', {})).body).workspace.path, '/Users/me/comic');
});
