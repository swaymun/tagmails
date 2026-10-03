import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import test from 'node:test';
import { handleDeviceRequest } from './device-jobs.mjs';
import { handleInbound } from './relay-worker.mjs';
import { bindings } from './bindings-fixture.mjs';

function device(sqlite, accountId = 'account-1') {
  const token = `tm_dev_${randomBytes(32).toString('base64url')}`;
  const id = `device-${randomBytes(4).toString('hex')}`;
  const hash = createHash('sha256').update(token).digest('hex');
  sqlite.prepare('INSERT INTO devices (id, account_id, token_hash) VALUES (?, ?, ?)').run(id, accountId, hash);
  return { id, token };
}

function envelope(body) { return JSON.parse(Buffer.from(body.payload, 'base64url').toString('utf8')); }

async function inbound(env, id = 'email-1') {
  const messageId = `<${id}@gmail.com>`;
  const rawMime = Buffer.from([
    'From: owner@gmail.com', 'To: agent@wonder.test', 'Subject: Check routing',
    `Message-ID: ${messageId}`, 'Content-Type: text/plain; charset=utf-8', '',
    'Model: Luna\nRead the status without changing files.',
  ].join('\r\n'));
  const message = {
    providerEmailId: id, messageId, from: 'owner@gmail.com', agentAddress: 'agent@wonder.test', to: ['agent@wonder.test'],
    cc: [], bcc: [], subject: 'Check routing', body: 'Model: Luna\nRead the status without changing files.',
    parentIds: [], rawMime,
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
  assert.match(signedJob.request.body, /Read the status/);
  assert.equal(body.signature, createHmac('sha256', paired.token).update(Buffer.from(body.payload, 'base64url')).digest('base64url'));
  assert.deepEqual((await call(env, paired.token, 'claim')).body, { claimed: false });

  const lease = { jobId: signedJob.jobId, leaseId: signedJob.leaseId };
  assert.equal((await call(env, paired.token, 'renew', lease)).body.renewed, true);
  const result = { state: 'completed', summary: 'The local agent read the status.' };
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
