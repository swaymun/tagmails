import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { handleDeviceRequest } from './device-jobs.mjs';
import { handleInbound } from './relay-worker.mjs';
import { bindings } from './bindings-fixture.mjs';
import { handleAccountRequest } from './account-auth.mjs';
import { deleteExpiredRunArtifacts } from './run-artifacts.mjs';
import { sendNextOutbox } from './outbox.mjs';

function device(sqlite, accountId = 'account-1') {
  const token = `tm_dev_${randomBytes(32).toString('base64url')}`;
  const id = `device-${randomBytes(4).toString('hex')}`;
  const hash = createHash('sha256').update(token).digest('hex');
  sqlite.prepare('INSERT INTO devices (id, account_id, token_hash) VALUES (?, ?, ?)').run(id, accountId, hash);
  return { id, token };
}

function envelope(body) { return JSON.parse(Buffer.from(body.payload, 'base64url').toString('utf8')); }

async function inbound(env, id = 'email-1', body = 'Model: Luna\nRead the status without changing files.', parentIds = []) {
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
  assert.deepEqual(await response.json(), { accepted: true, duplicate: false });
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
    { id: 'gpt-6-luna', effort: 'low', source: 'explicit' });
});

test('quoted model lines do not reroute a received reply', async () => {
  const { env, sqlite } = bindings();
  sqlite.prepare('UPDATE accounts SET default_model = ? WHERE id = ?').run('claude-sonnet-5-5', 'account-1');
  await inbound(env, 'original-route', 'Model: Luna\nDraft the review.');
  await inbound(env, 'quoted-route', 'Please review this.\n\nOn Friday, Alex wrote:\nModel: Luna',
    ['<original-route@gmail.com>']);
  const jobs = sqlite.prepare(`SELECT j.thread_id, j.model_json FROM jobs j
    JOIN messages m ON m.id = j.message_id ORDER BY m.provider_email_id`).all();
  assert.equal(jobs[0].thread_id, jobs[1].thread_id);
  assert.deepEqual(JSON.parse(jobs[1].model_json),
    { id: 'claude-sonnet-5-5', effort: 'medium', source: 'default' });
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
  assert.deepEqual(signedJob.model, { id: 'gpt-6-luna', effort: 'low', source: 'explicit' });
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
  const second = envelope((await call(env, secondDevice.token, 'claim')).body);
  assert.equal(second.jobId, first.jobId);
  assert.notEqual(second.leaseId, first.leaseId);
  const result = { state: 'completed', summary: 'Finished after recovery.' };
  assert.equal((await call(env, firstDevice.token, 'complete', { jobId: first.jobId, leaseId: first.leaseId, result })).status, 404);
  assert.equal((await call(env, secondDevice.token, 'complete', { jobId: second.jobId, leaseId: first.leaseId, result })).status, 409);
  assert.equal((await call(env, secondDevice.token, 'complete', { jobId: second.jobId, leaseId: second.leaseId, result })).status, 200);
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
