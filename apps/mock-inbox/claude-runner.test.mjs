import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runClaim } from './claude-runner.mjs';

function claim(jobId, body = 'Summarize this workspace.') {
  return {
    claimed: true, jobId, claimId: `claim-${jobId}`, threadId: 'thread-1',
    model: { id: 'claude-sonnet-5-5', effort: 'medium' },
    request: { from: 'owner@gmail.com', subject: 'Workspace summary', body, attachments: [] },
  };
}

test('Claude read-only adapter resumes only its saved thread and caches completed jobs', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tagmails-claude-test-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const fakeBin = path.join(workspace, 'fake-claude');
  fs.writeFileSync(fakeBin, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
let prompt = '';
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  const attachmentLine = prompt.split(String.fromCharCode(10)).find(line => line.startsWith('1. /'));
  const attachment = attachmentLine?.split(' (')[0].slice(3);
  const attachmentText = attachment ? fs.readFileSync(attachment, 'utf8') : null;
  fs.appendFileSync(path.join(process.cwd(), 'calls.jsonl'), JSON.stringify({ args, prompt, attachment, attachmentText, hadApiKey: Boolean(process.env.ANTHROPIC_API_KEY) }) + '\\n');
  const resumed = args.includes('--resume');
  const budgetFail = prompt.includes('[budget-fail]');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: budgetFail ? 'error_max_budget_usd' : 'success', is_error: budgetFail,
    session_id: '33333333-3333-4333-8333-333333333333', result: resumed ? 'Second turn.' : 'First turn.',
    modelUsage: { 'claude-sonnet-5-5': { inputTokens: 2, cacheReadInputTokens: 100,
      cacheCreationInputTokens: 200, outputTokens: 30, thinkingTokens: 4, costUSD: 0.010528, costBasis: 'list' },
      'claude-haiku-helper': { inputTokens: 3, cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0, outputTokens: 2, costUSD: 0.000012, costBasis: 'list' } } }));
});
`, { mode: 0o755 });
  const keys = ['TAGMAILS_WORKSPACE', 'TAGMAILS_CLAUDE_SESSION_FILE', 'TAGMAILS_CLAUDE_BIN', 'ANTHROPIC_API_KEY'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    TAGMAILS_WORKSPACE: workspace,
    TAGMAILS_CLAUDE_SESSION_FILE: path.join(workspace, 'sessions.json'),
    TAGMAILS_CLAUDE_BIN: fakeBin,
    ANTHROPIC_API_KEY: 'FAKE_TEST_KEY',
  });
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const attached = claim('job-1');
  attached.request.attachments = [{ name: 'note.txt', mimeType: 'text/plain', size: 17,
    data: Buffer.from('Claude test note.').toString('base64') }];
  const first = await runClaim(attached);
  assert.equal(first.state, 'completed');
  assert.deepEqual(first.usage, { inputTokens: 305, cachedInputTokens: 100,
    cacheCreationInputTokens: 200, outputTokens: 32, reasoningOutputTokens: 4 });
  assert.ok(Math.abs(first.reportedListCostUsd - 0.01054) < 1e-10);
  assert.deepEqual(await runClaim(claim('job-1')), first);
  const second = await runClaim(claim('job-2', 'Continue the summary.'));
  assert.equal(second.state, 'completed');
  assert.match(second.summary, /Second turn/);
  const calls = fs.readFileSync(path.join(workspace, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].args.includes('--restricted'));
  assert.ok(calls[0].args.includes('--safe-mode'));
  assert.ok(calls[0].args.includes('Read,Glob,Grep'));
  assert.equal(calls[0].attachmentText, 'Claude test note.');
  assert.equal(calls[0].args[calls[0].args.indexOf('--add-dir') + 1], path.dirname(calls[0].attachment));
  assert.equal(fs.existsSync(calls[0].attachment), false);
  assert.ok(!calls[0].args.includes('--resume'));
  assert.ok(calls[1].args.includes('33333333-3333-4333-8333-333333333333'));
  assert.ok(calls[1].prompt.includes('Continue the summary.'));
  assert.equal(calls[0].hadApiKey, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(workspace, 'sessions.json'))).threads['thread-1'].workspace, workspace);

  const budgetFailure = await runClaim(claim('job-3', '[budget-fail]'));
  assert.equal(budgetFailure.state, 'failed');
  assert.ok(budgetFailure.usage.inputTokens > 0);
  assert.deepEqual(await runClaim(claim('job-3', '[budget-fail]')), budgetFailure);
  assert.equal(fs.readFileSync(path.join(workspace, 'calls.jsonl'), 'utf8').trim().split('\n').length, 3);

  assert.equal((await runClaim({ ...claim('job-4'), model: { id: 'claude-opus-5-5', effort: 'medium' } })).state, 'failed');
  assert.equal(fs.readFileSync(path.join(workspace, 'calls.jsonl'), 'utf8').trim().split('\n').length, 3);
});
