// Opt-in local smoke: one real Codex Luna turn reads a synthetic image attachment.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseInbound, RELAY_INBOUND_LIMITS } from '../apps/mock-inbox/inbound.mjs';
import { bindings } from '../services/bindings-fixture.mjs';
import { handleInbound } from '../services/relay-worker.mjs';
import { handleDeviceRequest } from '../services/device-jobs.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tagmails-vision-smoke-'));
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace);
const token = `tm_dev_${randomBytes(32).toString('base64url')}`;
const tokenFile = path.join(root, 'device-token');
fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
const { env, sqlite, objects } = bindings();
sqlite.prepare('INSERT INTO devices (id, account_id, token_hash) VALUES (?, ?, ?)')
  .run('vision-smoke-device', 'account-1', createHash('sha256').update(token).digest('hex'));

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), '../apps/mock-inbox/fixtures/vision-orbit-47.png');
const image = fs.readFileSync(fixture);
const body = 'Model: Luna\nRead the attached image and report the exact word and number printed inside its border. Do not infer them from the filename.';
const boundary = 'tagmails-vision-smoke';
const rawMime = Buffer.from([
  'From: owner@gmail.com', 'To: agent@wonder.test', 'Subject: Image input smoke',
  'Message-ID: <vision-input-smoke@gmail.com>', 'MIME-Version: 1.0',
  `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
  `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', body, '',
  `--${boundary}`, 'Content-Type: image/png; name="sample.png"',
  'Content-Disposition: attachment; filename="sample.png"',
  'Content-Transfer-Encoding: base64', '', image.toString('base64'), '',
  `--${boundary}--`, '',
].join('\r\n'));
const parsed = await parseInbound(rawMime, 'agent@wonder.test', {
  verifiedDeliveryToAgent: true, ...RELAY_INBOUND_LIMITS, includeAttachmentData: false,
});
assert.equal(parsed.attachments.length, 1);
const intake = await handleInbound(new Request('http://127.0.0.1:8787/webhooks/resend', {
  method: 'POST', body: '{}',
}), env, { inspect: async () => ({ ...parsed, providerEmailId: 'vision-input-smoke',
  agentAddress: 'agent@wonder.test', rawMime }) });
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
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const child = spawn('cargo', ['run', '--quiet', '--manifest-path', 'crates/tagmails-daemon/Cargo.toml', '--', '--once'], {
    cwd: process.cwd(), env: { ...process.env,
      TAGMAILS_RELAY_URL: `http://127.0.0.1:${server.address().port}`,
      TAGMAILS_WORKSPACE: workspace, TAGMAILS_DEVICE_TOKEN_FILE: tokenFile,
      TAGMAILS_CODEX_RUNTIME_HOME: path.join(root, 'codex-home'),
      TAGMAILS_SESSION_FILE: path.join(root, 'sessions.json') },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0, `${stdout}\n${stderr}`);
  const job = sqlite.prepare('SELECT id, state, result_key FROM jobs').get();
  assert.equal(job.state, 'completed');
  const result = JSON.parse(objects.get(job.result_key));
  const answer = [result.summary, ...(result.details ?? [])].join(' ');
  assert.match(answer, /ORBIT/i);
  assert.match(answer, /47/);
  assert.equal(sqlite.prepare('SELECT state FROM outbox').get().state, 'queued');
  console.log(JSON.stringify({ jobId: job.id, state: job.state,
    answer, toolSteps: result.transcript.events.filter((event) => event.kind === 'tool').length,
    usage: result.usage ?? null, replyQueued: true }));
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
