// Opt-in local smoke: owner and authorized guest edit one scratch file in a signed relay thread.
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { bindings } from '../services/bindings-fixture.mjs';
import { handleInbound } from '../services/relay-worker.mjs';
import { handleDeviceRequest } from '../services/device-jobs.mjs';
import { sendNextOutbox } from '../services/outbox.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tagmails-write-smoke-'));
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace);
const token = `tm_dev_${randomBytes(32).toString('base64url')}`;
const tokenFile = path.join(root, 'device-token');
fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
const { env, sqlite, objects } = bindings();
const webhookSecret = `whsec_${randomBytes(32).toString('base64')}`;
env.RESEND_WEBHOOK_SECRET = webhookSecret;
const sends = [];
const provider = {
  async sendEmail(payload, options) {
    const id = randomUUID();
    sends.push({ id, payload, options });
    return { data: { id } };
  },
  async getSentEmail(id) { return { data: { message_id: `<${id}@tagmails.test>` } }; },
};
sqlite.prepare('INSERT INTO devices (id, account_id, token_hash) VALUES (?, ?, ?)')
  .run('write-smoke-device', 'account-1', createHash('sha256').update(token).digest('hex'));
async function deliverSigned({ from, to, cc = [], messageId, rawMime }) {
  const emailId = randomUUID();
  const metadata = { email_id: emailId, message_id: messageId, from, to, cc, bcc: [] };
  const payload = JSON.stringify({ type: 'email.received', data: metadata });
  const eventId = `msg_${randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', Buffer.from(webhookSecret.slice(6), 'base64'))
    .update(`${eventId}.${timestamp}.${payload}`).digest('base64');
  const request = new Request('http://127.0.0.1:8787/webhooks/resend', {
    method: 'POST', body: payload,
    headers: { 'svix-id': eventId, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` },
  });
  const response = await handleInbound(request, env, {
    getReceivedEmail: async (id) => {
      assert.equal(id, emailId);
      return { ...metadata, id: emailId, authentication: { dmarc: 'pass' },
        raw: { download_url: `https://inbound.resend.com/raw/${emailId}` } };
    },
    fetchRaw: async (url, options) => {
      assert.equal(url, `https://inbound.resend.com/raw/${emailId}`);
      assert.equal(options.redirect, 'error');
      return new Response(rawMime);
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: true, duplicate: false });
}
const body = 'Model: Luna\nCreate proof.txt in the selected workspace with exactly: signed relay write works';
const rawMime = Buffer.from(`From: owner@gmail.com\r\nTo: agent@wonder.test\r\nCc: reviewer@gmail.com\r\nSubject: Signed write smoke\r\nMessage-ID: <write-smoke@gmail.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`);
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
  await deliverSigned({ from: 'owner@gmail.com', to: ['agent@wonder.test'], cc: ['reviewer@gmail.com'],
    messageId: '<write-smoke@gmail.com>', rawMime });
  await runOnce();
  const firstJob = sqlite.prepare('SELECT state, result_key FROM jobs ORDER BY created_at, id LIMIT 1').get();
  const firstResult = JSON.parse(objects.get(firstJob.result_key));
  assert.equal(firstJob.state, 'completed', firstResult.summary);
  assert.ok(fs.existsSync(path.join(workspace, 'proof.txt')),
    JSON.stringify({ summary: firstResult.summary, checks: firstResult.checks,
      events: firstResult.transcript?.events }));
  assert.equal(fs.readFileSync(path.join(workspace, 'proof.txt'), 'utf8').trim(), 'signed relay write works');
  const firstSend = await sendNextOutbox(env, provider);
  assert.equal(firstSend.state, 'sent');
  assert.deepEqual(sends[0].payload.to, ['owner@gmail.com']);
  assert.deepEqual(sends[0].payload.cc, ['reviewer@gmail.com']);
  assert.equal(sends[0].payload.headers['In-Reply-To'], '<write-smoke@gmail.com>');
  assert.equal(sends[0].payload.headers.References, '<write-smoke@gmail.com>');

  const guestBody = 'Model: Luna\nAdd a second line to proof.txt containing exactly: guest turn works';
  const guestMime = Buffer.from(`From: reviewer@gmail.com\r\nTo: agent@wonder.test, owner@gmail.com\r\nSubject: Re: Signed write smoke\r\nMessage-ID: <write-smoke-guest@gmail.com>\r\nIn-Reply-To: ${firstSend.messageId}\r\nReferences: <write-smoke@gmail.com> ${firstSend.messageId}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${guestBody}`);
  await deliverSigned({ from: 'reviewer@gmail.com', to: ['agent@wonder.test', 'owner@gmail.com'],
    messageId: '<write-smoke-guest@gmail.com>', rawMime: guestMime });
  await runOnce();
  const jobs = sqlite.prepare('SELECT id, state, result_key FROM jobs').all();
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every((job) => job.state === 'completed' && JSON.parse(objects.get(job.result_key)).runtime === 'codex-app-server-write'));
  assert.equal(sqlite.prepare('SELECT count(*) n FROM threads').get().n, 1);
  assert.deepEqual(sqlite.prepare('SELECT email FROM participants').all().map((row) => row.email), ['reviewer@gmail.com']);
  assert.ok(fs.existsSync(path.join(workspace, 'proof.txt')),
    JSON.stringify({ state: jobs[1].state, summary: JSON.parse(objects.get(jobs[1].result_key)).summary }));
  assert.equal(fs.readFileSync(path.join(workspace, 'proof.txt'), 'utf8').trim(), 'signed relay write works\nguest turn works');
  const secondSend = await sendNextOutbox(env, provider);
  assert.equal(secondSend.state, 'sent');
  assert.deepEqual(sends[1].payload.to, ['reviewer@gmail.com']);
  assert.deepEqual(sends[1].payload.cc, ['owner@gmail.com']);
  assert.equal(sends[1].payload.headers['In-Reply-To'], '<write-smoke-guest@gmail.com>');
  assert.equal(sends[1].payload.headers.References,
    `<write-smoke@gmail.com> ${firstSend.messageId} <write-smoke-guest@gmail.com>`);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM outbox WHERE state = 'sent'").get().n, 2);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM messages WHERE direction = 'outbound'").get().n, 2);
  console.log(JSON.stringify({ jobs: jobs.length, states: jobs.map((job) => job.state),
    runtime: 'codex-app-server-write', file: 'proof.txt', repliesSentToStub: sends.length,
    firstTurnTools: firstResult.transcript?.events.filter((event) => event.kind === 'tool').map((event) => event.text),
    secondReplyThreadedTo: secondSend.messageId }));
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
