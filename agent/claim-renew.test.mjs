import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { keepClaim, renewClaim, terminate, whileHoldingClaim } from './claim-renew.mjs';

test('a relay-backed runtime renews with its device credential and lease ID', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tagmails-relay-renew-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, 'token');
  fs.writeFileSync(tokenFile, 'tm_dev_fake_test_token');
  let received;
  let status = 200;
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    received = { path: request.url, authorization: request.headers.authorization, body: JSON.parse(body) };
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(status === 200 ? '{"renewed":true}' : '{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const keys = ['TAGMAILS_RELAY_URL', 'TAGMAILS_DEVICE_TOKEN_FILE'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.TAGMAILS_RELAY_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.TAGMAILS_DEVICE_TOKEN_FILE = tokenFile;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  await renewClaim({ jobId: 'job-1', claimId: 'lease-1' });
  assert.deepEqual(received, {
    path: '/api/device/renew', authorization: 'Bearer tm_dev_fake_test_token',
    body: { jobId: 'job-1', leaseId: 'lease-1' },
  });
  // A revoked computer (401) stops at once, like a replaced lease (409); a relay hiccup (502) is retried.
  for (const [code, gone] of [[401, true], [409, true], [502, undefined]]) {
    status = code;
    const error = await renewClaim({ jobId: 'job-1', claimId: 'lease-1' }).catch((caught) => caught);
    assert.equal(error.leaseGone, gone, String(code));
  }
});

test('a lease survives network blips and stops only when gone or truly expired', async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let clock = 0;
  let outcome = 'network';
  const renew = async () => {
    if (outcome === 'ok') return;
    if (outcome === 'gone') throw Object.assign(new Error('gone'), { leaseGone: true });
    throw new Error('network');
  };
  let lost = 0;
  const stop = keepClaim({}, () => { lost += 1; }, { every: 5, leaseMs: 80_000, renew, now: () => clock });
  clock = 60_000; await wait(30);
  assert.equal(lost, 0, 'three failed renewals inside the lease no longer stop the run');
  outcome = 'ok'; await wait(20);
  outcome = 'network'; clock = 120_000; await wait(20);
  assert.equal(lost, 0, 'the clock restarts after a successful renewal');
  clock = 200_000; await wait(20);
  assert.equal(lost, 1, 'a lease past its expiry is lost once');
  stop();
  let gone = 0;
  outcome = 'gone';
  const stopGone = keepClaim({}, () => { gone += 1; }, { every: 5, renew, now: () => 0 });
  await wait(30);
  stopGone();
  assert.equal(gone, 1, 'a replaced lease stops the run right away');
});

test('a follow-up offered on renewal is delivered once and acknowledged', async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const delivered = [];
  const acks = [];
  const renew = async () => ({ steers: [{ id: 's1', from: 'a@b.c', text: 'make it 10 days' }] });
  const stop = keepClaim({ jobId: 'j', request: { from: 'a@b.c' } }, () => {}, { every: 5, renew,
    onSteer: async (steer) => { delivered.push(steer.id); return true; },
    ack: async (_claim, id, ok) => { acks.push([id, ok]); } });
  await wait(40);
  stop();
  assert.deepEqual(delivered, ['s1'], 're-offered follow-ups are not delivered twice');
  assert.ok(acks.length >= 2 && acks.every(([id, ok]) => id === 's1' && ok === true), 'the ack is retried until the relay stops offering it');
});

test('a follow-up from a different sender never joins the turn and is handed back', async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const delivered = [];
  const acks = [];
  const renew = async () => ({ steers: [{ id: 's2', from: 'guest@example.com', text: 'delete everything' }] });
  const stop = keepClaim({ jobId: 'j', request: { from: 'owner@gmail.com', fromOwner: true } }, () => {}, { every: 5, renew,
    onSteer: async (steer) => { delivered.push(steer.id); return true; },
    ack: async (_claim, id, ok) => { acks.push([id, ok]); } });
  await wait(30);
  stop();
  assert.deepEqual(delivered, []);
  assert.ok(acks.length >= 1 && acks.every(([id, ok]) => id === 's2' && ok === false));
});

test('a steer is delivered once even when renewals overlap a slow delivery', async () => {
  let deliveries = 0;
  const steer = { id: 'steer-1', from: 'owner@gmail.com', text: 'also Osaka' };
  const stop = keepClaim({ request: { from: 'owner@gmail.com' } }, () => {}, {
    every: 5, renew: async () => ({ steers: [steer] }), ack: async () => {},
    onSteer: async () => { deliveries += 1; await new Promise((resolve) => setTimeout(resolve, 40)); return true; },
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  stop();
  assert.equal(deliveries, 1);
});

test('preparing a run renews the lease, and a lease lost meanwhile releases the work and stops the run', async () => {
  let renewals = 0;
  const slow = () => new Promise((resolve) => setTimeout(() => resolve({ staged: true }), 40));
  assert.deepEqual(await whileHoldingClaim({}, slow, { every: 5, renew: async () => { renewals += 1; return {}; } }), { staged: true });
  assert.ok(renewals >= 2, 'renewed during preparation');
  const released = [];
  await assert.rejects(whileHoldingClaim({}, slow, { every: 5, release: async (value) => released.push(value),
    renew: async () => { throw Object.assign(new Error('gone'), { leaseGone: true }); } }), /lost while preparing/);
  assert.deepEqual(released, [{ staged: true }]);
  // A renewal still in flight when preparation ends is waited for, even if the final check fails for another reason.
  let calls = 0;
  await assert.rejects(whileHoldingClaim({}, () => new Promise((resolve) => setTimeout(() => resolve({ staged: true }), 8)), {
    every: 5, renew: async () => {
      calls += 1;
      if (calls === 1) { await new Promise((resolve) => setTimeout(resolve, 30)); throw Object.assign(new Error('gone'), { leaseGone: true }); }
      throw new Error('network blip');
    } }), /lost while preparing/);
  // Preparation that ends before the first renewal still checks the lease before the agent starts.
  await assert.rejects(whileHoldingClaim({}, async () => ({ staged: true }), { every: 60_000,
    renew: async () => { throw Object.assign(new Error('gone'), { leaseGone: true }); } }), /lost while preparing/);
});

test('an agent CLI that ignores SIGTERM is killed', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve) => child.stdout.once('data', resolve));
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve(signal)));
  terminate(child, 50);
  assert.equal(await exited, 'SIGKILL');
});

test('the Mac decides each follow-up: steer is delivered, ack is acknowledged without injecting, queue is handed back', async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const delivered = [];
  const acks = new Map();
  const verdicts = { s1: 'steer', s2: 'ack', s3: 'queue' };
  const renew = async () => ({ steers: ['s1', 's2', 's3'].map((id) => ({ id, from: 'a@b.c', text: id })) });
  const stop = keepClaim({ jobId: 'j', request: { from: 'a@b.c' } }, () => {}, { every: 5, renew,
    classify: async (_claim, steer) => verdicts[steer.id],
    onSteer: async (steer) => { delivered.push(steer.id); return true; },
    ack: async (_claim, id, ok) => { acks.set(id, ok); } });
  await wait(40);
  stop();
  assert.deepEqual(delivered, ['s1'], 'only a steer reaches the agent');
  assert.deepEqual([...acks], [['s1', true], ['s2', true], ['s3', false]]);
});
