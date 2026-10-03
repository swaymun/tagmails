// Opt-in local smoke: owner and authorized guest edit one scratch file in a signed relay thread.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { bindings } from '../services/bindings-fixture.mjs';
import { handleInbound } from '../services/relay-worker.mjs';
import { handleDeviceRequest } from '../services/device-jobs.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tagmails-write-smoke-'));
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace);
const token = `tm_dev_${randomBytes(32).toString('base64url')}`;
const tokenFile = path.join(root, 'device-token');
fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
const { env, sqlite, objects } = bindings();
sqlite.prepare('INSERT INTO devices (id, account_id, token_hash) VALUES (?, ?, ?)')
  .run('write-smoke-device', 'account-1', createHash('sha256').update(token).digest('hex'));
const body = 'Model: Luna\nCreate proof.txt in the selected workspace with exactly: signed relay write works';
const rawMime = Buffer.from(`From: owner@gmail.com\r\nTo: agent@wonder.test\r\nCc: reviewer@gmail.com\r\nSubject: Signed write smoke\r\nMessage-ID: <write-smoke@gmail.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`);
const intake = await handleInbound(new Request('http://127.0.0.1:8787/webhooks/resend', { method: 'POST', body: '{}' }), env, {
  inspect: async () => ({ providerEmailId: 'write-smoke', messageId: '<write-smoke@gmail.com>',
    from: 'owner@gmail.com', agentAddress: 'agent@wonder.test', to: ['agent@wonder.test'], cc: ['reviewer@gmail.com'], bcc: [],
    subject: 'Signed write smoke', body, parentIds: [], rawMime }),
});
assert.equal(intake.status, 200);
const server = http.createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = new Request(`http://127.0.0.1:${server.address().port}${request.url}`, {
      method: request.method, headers: request.headers,
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    const output = await handleDeviceRequest(input, env);
    response.writeHead(output.status, Object.fromEntries(output.headers));
    response.end(Buffer.from(await output.arrayBuffer()));
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
async function runOnce() {
  const child = spawn('cargo', ['run', '--quiet', '--manifest-path', 'crates/tagmails-daemon/Cargo.toml', '--', '--once'], {
    cwd: process.cwd(), env: { ...process.env,
      TAGMAILS_RELAY_URL: `http://127.0.0.1:${server.address().port}`,
      TAGMAILS_WORKSPACE: workspace, TAGMAILS_WORKSPACE_ACCESS: 'write', TAGMAILS_DEVICE_TOKEN_FILE: tokenFile,
      TAGMAILS_CODEX_RUNTIME_HOME: path.join(root, 'codex-home'),
      TAGMAILS_SESSION_FILE: path.join(root, 'sessions.json') },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0, `${stdout}\n${stderr}`);
}
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await runOnce();
  assert.equal(fs.readFileSync(path.join(workspace, 'proof.txt'), 'utf8').trim(), 'signed relay write works');

  const guestBody = 'Model: Luna\nAdd a second line to proof.txt containing exactly: guest turn works';
  const guestMime = Buffer.from(`From: reviewer@gmail.com\r\nTo: agent@wonder.test\r\nSubject: Re: Signed write smoke\r\nMessage-ID: <write-smoke-guest@gmail.com>\r\nIn-Reply-To: <write-smoke@gmail.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${guestBody}`);
  const guestIntake = await handleInbound(new Request('http://127.0.0.1:8787/webhooks/resend', { method: 'POST', body: '{}' }), env, {
    inspect: async () => ({ providerEmailId: 'write-smoke-guest', messageId: '<write-smoke-guest@gmail.com>',
      from: 'reviewer@gmail.com', agentAddress: 'agent@wonder.test', to: ['agent@wonder.test'], cc: [], bcc: [],
      subject: 'Re: Signed write smoke', body: guestBody, parentIds: ['<write-smoke@gmail.com>'], rawMime: guestMime }),
  });
  assert.equal(guestIntake.status, 200);
  assert.equal((await guestIntake.json()).accepted, true);
  await runOnce();
  const jobs = sqlite.prepare('SELECT id, state, result_key FROM jobs').all();
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every((job) => job.state === 'completed' && JSON.parse(objects.get(job.result_key)).runtime === 'codex-app-server-write'));
  assert.equal(sqlite.prepare('SELECT count(*) n FROM threads').get().n, 1);
  assert.deepEqual(sqlite.prepare('SELECT email FROM participants').all().map((row) => row.email), ['reviewer@gmail.com']);
  assert.equal(fs.readFileSync(path.join(workspace, 'proof.txt'), 'utf8').trim(), 'signed relay write works\nguest turn works');
  assert.equal(sqlite.prepare("SELECT count(*) n FROM outbox WHERE state = 'queued'").get().n, 2);
  console.log(JSON.stringify({ jobs: jobs.length, states: jobs.map((job) => job.state),
    runtime: 'codex-app-server-write', file: 'proof.txt', repliesQueued: 2 }));
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
