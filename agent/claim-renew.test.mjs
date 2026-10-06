import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { keepClaim, renewClaim } from './claim-renew.mjs';

test('a relay-backed runtime renews with its device credential and lease ID', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tagmails-relay-renew-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, 'token');
  fs.writeFileSync(tokenFile, 'tm_dev_fake_test_token');
  let received;
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    received = { path: request.url, authorization: request.headers.authorization, body: JSON.parse(body) };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"renewed":true}');
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
