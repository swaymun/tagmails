// Opt-in local smoke: runs one real Codex Luna turn against synthetic mail and a scratch workspace.
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tagmails-answer-smoke-'));
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace, 'note.txt'), 'codename: Maple Beacon\nstatus: ready\n');
const token = `tm_dev_${randomBytes(32).toString('base64url')}`;
const tokenFile = path.join(root, 'device-token');
fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
const { env, sqlite, objects } = bindings();
sqlite.prepare('INSERT INTO devices (id, account_id, token_hash) VALUES (?, ?, ?)')
  .run('smoke-device', 'account-1', createHash('sha256').update(token).digest('hex'));
const body = 'TagMails-Attach: answer.txt\nModel: Luna\nRead note.txt in the current workspace. State the codename and status.';
const rawMime = Buffer.from(`From: owner@gmail.com\r\nTo: agent@wonder.test\r\nSubject: Answer export smoke\r\nMessage-ID: <answer-export-smoke@gmail.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`);
const intake = await handleInbound(new Request('http://127.0.0.1:8787/webhooks/resend', { method: 'POST', body: '{}' }), env, {
  inspect: async () => ({ providerEmailId: 'answer-export-smoke', messageId: '<answer-export-smoke@gmail.com>',
    from: 'owner@gmail.com', agentAddress: 'agent@wonder.test', to: ['agent@wonder.test'], cc: [], bcc: [],
    subject: 'Answer export smoke', body, parentIds: [], rawMime }),
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
  assert.equal(result.artifactIds.length, 1);
  assert.ok(result.transcript.events.some((event) => event.kind === 'tool'), 'Codex did not inspect the scratch file');
  const file = sqlite.prepare('SELECT object_key, name, byte_size FROM run_artifacts WHERE id = ?').get(result.artifactIds[0]);
  assert.equal(file.name, 'answer.txt');
  const text = objects.get(file.object_key).toString();
  assert.match(text, /Maple Beacon/i);
  assert.match(text, /ready/i);
  assert.equal(sqlite.prepare('SELECT state FROM outbox').get().state, 'queued');
  console.log(JSON.stringify({ jobId: job.id, state: job.state, artifactName: file.name,
    artifactBytes: file.byte_size, artifactSha256: createHash('sha256').update(text).digest('hex'),
    replyQueued: true, toolSteps: result.transcript.events.filter((event) => event.kind === 'tool').length,
    reasoningSummaries: result.transcript.events.filter((event) => event.kind === 'reasoning').length }));
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
