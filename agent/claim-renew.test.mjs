import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { renewClaim } from './claim-renew.mjs';

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
