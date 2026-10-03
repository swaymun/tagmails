import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runClaim } from './codex-runner.mjs';

function claim(jobId, threadId, body = 'Summarize this workspace.') {
  return {
    claimed: true, jobId, claimId: `claim-${jobId}`, threadId,
    model: { id: 'gpt-6-luna', effort: 'low' },
    request: { from: 'owner@gmail.com', subject: 'Workspace summary', body, attachments: [] },
  };
}

test('Codex read-only adapter resumes a thread and reuses a completed job result', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tagmails-runner-test-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const fakeBin = path.join(workspace, 'fake-codex');
  const fakeSource = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
let prompt = '';
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  const resumed = args.includes('resume');
  const output = args[args.indexOf('-o') + 1];
  const id = '11111111-1111-4111-8111-111111111111';
  const attachmentLine = prompt.split(String.fromCharCode(10)).find(line => line.startsWith('1. /'));
  const attachment = attachmentLine?.split(' (')[0].slice(3);
  const attachmentText = attachment ? fs.readFileSync(attachment, 'utf8') : null;
  fs.appendFileSync(path.join(process.cwd(), 'calls.jsonl'), JSON.stringify({ args, prompt, attachment, attachmentText, hadApiKey: Boolean(process.env.OPENAI_API_KEY) }) + '\\n');
  fs.writeFileSync(output, resumed ? 'First turn plus second turn.' : 'First turn.');
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: id }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1200,
    cached_input_tokens: 300, cache_write_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 12 } }) + '\\n');
});
`;
  fs.writeFileSync(fakeBin, fakeSource, { mode: 0o755 });
  const previous = Object.fromEntries(['TAGMAILS_WORKSPACE', 'TAGMAILS_SESSION_FILE', 'TAGMAILS_CODEX_BIN', 'OPENAI_API_KEY'].map((key) => [key, process.env[key]]));
  process.env.TAGMAILS_WORKSPACE = workspace;
  process.env.TAGMAILS_SESSION_FILE = path.join(workspace, 'sessions.json');
  process.env.TAGMAILS_CODEX_BIN = fakeBin;
  process.env.OPENAI_API_KEY = 'FAKE_TEST_KEY';
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const attached = claim('job-1', 'thread-1');
  attached.request.attachments = [{ name: 'note.txt', mimeType: 'text/plain', size: 16,
    data: Buffer.from('Agent test note.').toString('base64') }];
  const first = await runClaim(attached);
  assert.equal(first.state, 'completed');
  assert.match(first.summary, /First turn/);
  assert.deepEqual(first.usage, { inputTokens: 1200, cachedInputTokens: 300,
    cacheCreationInputTokens: 0, outputTokens: 40, reasoningOutputTokens: 12 });
  assert.deepEqual(await runClaim(claim('job-1', 'thread-1')), first);
  const second = await runClaim(claim('job-2', 'thread-1', 'Continue the summary.'));
  assert.equal(second.state, 'completed');
  assert.match(second.summary, /second turn/);

  const calls = fs.readFileSync(path.join(workspace, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].args.includes('read-only'));
  assert.ok(calls[0].args.includes(workspace));
  assert.equal(calls[0].attachmentText, 'Agent test note.');
  assert.equal(fs.existsSync(calls[0].attachment), false);
  assert.ok(calls[1].args.includes('resume'));
  assert.ok(calls[1].args.includes('sandbox_mode="read-only"'));
  assert.ok(calls[1].args.includes('11111111-1111-4111-8111-111111111111'));
  assert.ok(calls[1].prompt.includes('Continue the summary.'));
  assert.equal(calls[0].hadApiKey, false);
  const store = JSON.parse(fs.readFileSync(path.join(workspace, 'sessions.json'), 'utf8'));
  assert.equal(store.threads['thread-1'].sessionId, '11111111-1111-4111-8111-111111111111');
  assert.equal(Object.keys(store.jobs).length, 2);
});

test('a longer Codex turn renews its lab claim before completion', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tagmails-lease-test-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const fakeBin = path.join(workspace, 'fake-codex');
  fs.writeFileSync(fakeBin, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
process.stdin.resume();
process.stdin.on('end', () => setTimeout(() => {
  fs.writeFileSync(args[args.indexOf('-o') + 1], 'Slow turn completed.');
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: '22222222-2222-4222-8222-222222222222' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');
}, 160));
`, { mode: 0o755 });
  let renewals = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/api/renew') renewals += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"renewed":true}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const keys = ['TAGMAILS_WORKSPACE', 'TAGMAILS_SESSION_FILE', 'TAGMAILS_CODEX_BIN', 'TAGMAILS_LAB_URL', 'TAGMAILS_CLAIM_RENEW_MS'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    TAGMAILS_WORKSPACE: workspace,
    TAGMAILS_SESSION_FILE: path.join(workspace, 'sessions.json'),
    TAGMAILS_CODEX_BIN: fakeBin,
    TAGMAILS_LAB_URL: `http://127.0.0.1:${server.address().port}`,
    TAGMAILS_CLAIM_RENEW_MS: '20',
  });
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  assert.equal((await runClaim(claim('job-slow', 'thread-slow'))).state, 'completed');
  assert.ok(renewals >= 1);
});
