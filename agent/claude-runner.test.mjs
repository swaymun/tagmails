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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tagmails-claude-test-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fakeBin = path.join(root, 'fake-claude');
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
  if (prompt.includes('[abrupt-write]')) {
    fs.writeFileSync(path.join(process.cwd(), 'partial.txt'), 'one local edit\\n');
    process.exit(17);
  }
  const resumed = args.includes('--resume');
  const budgetFail = prompt.includes('[budget-fail]');
  const outsideDenied = prompt.includes('[outside-denied]');
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'thinking', thinking: 'SECRET_REASONING' },
    { type: 'tool_use', name: 'Read', input: { file_path: 'secret.txt' } },
    { type: 'text', text: 'Checking the workspace.' } ] } }) + '\\n');
  if (outsideDenied) process.stdout.write(JSON.stringify({ type: 'user', message: { content: [
    { type: 'tool_result', is_error: true, content: '/outside is outside /workspace; --restricted confines the file tools to the working directory.' } ] } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: budgetFail ? 'error_max_budget_usd' : 'success', is_error: budgetFail,
    session_id: '33333333-3333-4333-8333-333333333333', result: resumed ? 'Second turn.' : 'First turn.',
    modelUsage: { 'claude-sonnet-5-5': { inputTokens: 2, cacheReadInputTokens: 100,
      cacheCreationInputTokens: 200, outputTokens: 30, thinkingTokens: 4, costUSD: 0.010528, costBasis: 'list' },
      'claude-haiku-helper': { inputTokens: 3, cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0, outputTokens: 2, costUSD: 0.000012, costBasis: 'list' } } }));
  process.stdout.write('\\n');
});
`, { mode: 0o755 });
  const keys = ['TAGMAILS_WORKSPACE', 'TAGMAILS_CLAUDE_SESSION_FILE', 'TAGMAILS_CLAUDE_BIN', 'ANTHROPIC_API_KEY', 'TAGMAILS_RUNTIME'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    TAGMAILS_WORKSPACE: workspace,
    TAGMAILS_CLAUDE_SESSION_FILE: path.join(root, 'sessions.json'),
    TAGMAILS_CLAUDE_BIN: fakeBin,
    ANTHROPIC_API_KEY: 'FAKE_TEST_KEY',
    TAGMAILS_RUNTIME: 'claude-readonly',
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
  assert.deepEqual(first.transcript.events, [
    { kind: 'request', text: 'Summarize this workspace.' },
    { kind: 'tool', text: 'Read requested.' },
    { kind: 'assistant', phase: 'commentary', text: 'Checking the workspace.' },
    { kind: 'assistant', phase: 'final_answer', text: 'First turn.' },
  ]);
  assert.doesNotMatch(JSON.stringify(first.transcript), /SECRET_REASONING|secret\.txt/);
  assert.deepEqual(await runClaim(claim('job-1')), first);
  const second = await runClaim(claim('job-2', 'Continue the summary.'));
  assert.equal(second.state, 'completed');
  assert.match(second.summary, /Second turn/);
  const calls = fs.readFileSync(path.join(workspace, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].args.includes('--restricted'));
  assert.ok(calls[0].args.includes('--safe-mode'));
  assert.ok(calls[0].args.includes('Read,Glob,Grep'));
  assert.ok(calls[0].args.includes('mcp__*'));
  assert.equal(calls[0].attachmentText, 'Claude test note.');
  assert.ok(!calls[0].args.includes('--add-dir'));
  assert.equal(calls[0].attachment.startsWith(fs.realpathSync(workspace)), true);
  assert.equal(fs.existsSync(calls[0].attachment), false);
  assert.ok(!calls[0].args.includes('--resume'));
  assert.ok(calls[1].args.includes('33333333-3333-4333-8333-333333333333'));
  assert.ok(calls[1].prompt.includes('Continue the summary.'));
  assert.equal(calls[0].hadApiKey, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'sessions.json'))).threads['thread-1'].workspace, fs.realpathSync(workspace));

  const budgetFailure = await runClaim(claim('job-3', '[budget-fail]'));
  assert.equal(budgetFailure.state, 'failed');
  assert.ok(budgetFailure.usage.inputTokens > 0);
  assert.deepEqual(budgetFailure.transcript.events, [
    { kind: 'request', text: '[budget-fail]' },
    { kind: 'tool', text: 'Read requested.' },
    { kind: 'assistant', phase: 'commentary', text: 'Checking the workspace.' },
  ]);
  assert.doesNotMatch(JSON.stringify(budgetFailure.transcript), /SECRET_REASONING|secret\.txt/);
  assert.deepEqual(await runClaim(claim('job-3', '[budget-fail]')), budgetFailure);
  assert.equal(fs.readFileSync(path.join(workspace, 'calls.jsonl'), 'utf8').trim().split('\n').length, 3);

  // Any Claude model the machine offers runs; a non-Claude model never reaches the CLI.
  assert.equal((await runClaim({ ...claim('job-4'), model: { id: 'gpt-6-sol', effort: 'medium' } })).state, 'failed');
  assert.equal(fs.readFileSync(path.join(workspace, 'calls.jsonl'), 'utf8').trim().split('\n').length, 3);

  process.env.TAGMAILS_RUNTIME = 'claude-write';
  process.env.TAGMAILS_CLAUDE_SESSION_FILE = path.join(root, 'write-sessions.json');
  const written = await runClaim(claim('job-1', 'Create a note in this scratch workspace.'));
  assert.equal(written.runtime, 'claude-cli-write');
  assert.match(written.checks[0], /review its reported edits/);
  const writeCalls = fs.readFileSync(path.join(workspace, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(writeCalls.length, 4);
  assert.ok(writeCalls[3].args.includes('Read,Glob,Grep,Edit,Write'));
  assert.ok(writeCalls[3].args.includes('acceptEdits'));
  assert.ok(writeCalls[3].args.includes('--restricted'));
  assert.ok(writeCalls[3].args.includes('--safe-mode'));
  assert.ok(!writeCalls[3].args.includes('--resume'));
  assert.equal(writeCalls[3].hadApiKey, false);
  assert.match(writeCalls[3].prompt, /read and edit files in the selected workspace/);
  assert.doesNotMatch(writeCalls[3].args.join(' '), /Bash|WebFetch|WebSearch/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'write-sessions.json'))).threads['thread-1'].workspace, fs.realpathSync(workspace));
  // An owner email loads the owner's own Claude Code setup and connectors.
  const ownerClaim = claim('job-owner', 'Make a Google Doc from the notes.');
  ownerClaim.request.fromOwner = true;
  await runClaim(ownerClaim);
  const ownerArgs = fs.readFileSync(path.join(workspace, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).at(-1).args;
  for (const flag of ['--safe-mode', '--strict-mcp-config', '--disable-slash-commands', 'mcp__*']) assert.ok(!ownerArgs.includes(flag), flag);
  assert.deepEqual(ownerArgs.slice(ownerArgs.indexOf('--disallowedTools'), ownerArgs.indexOf('--disallowedTools') + 3),
    ['--disallowedTools', 'mcp__*__trash*', 'mcp__*__delete*']);
  assert.ok(ownerArgs.includes('--restricted') && ownerArgs.includes('--no-chrome'));
  assert.equal((await runClaim(claim('job-2', 'Continue.'))).runtime, 'claude-cli-write');
  const resumedWrite = fs.readFileSync(path.join(workspace, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  assert.ok(resumedWrite.args.includes('33333333-3333-4333-8333-333333333333'));
  const writeFailure = await runClaim({ ...claim('job-3'), model: { id: 'not-a-claude-model', effort: 'medium' } });
  assert.match(writeFailure.checks[0], /partial changes/);
  const denied = await runClaim(claim('job-4', '[outside-denied]'));
  assert.equal(denied.state, 'needs_approval');
  assert.match(denied.summary, /outside the selected workspace/);
  assert.match(denied.checks[0], /partial changes/);
  assert.match(JSON.stringify(denied.transcript), /File access outside the selected workspace was denied/);

  const interrupted = await runClaim(claim('job-5', '[abrupt-write]'));
  assert.equal(interrupted.state, 'failed');
  assert.match(interrupted.checks[0], /partial changes/);
  assert.equal(fs.readFileSync(path.join(workspace, 'partial.txt'), 'utf8'), 'one local edit\n');
  const callsAfterFailure = fs.readFileSync(path.join(workspace, 'calls.jsonl'), 'utf8').trim().split('\n').length;
  assert.deepEqual(await runClaim(claim('job-5', '[abrupt-write]')), interrupted);
  assert.equal(fs.readFileSync(path.join(workspace, 'calls.jsonl'), 'utf8').trim().split('\n').length, callsAfterFailure);
});

test('Claude adapter keeps its session store outside the selected workspace', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tagmails-claude-store-test-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = { workspace: process.env.TAGMAILS_WORKSPACE, store: process.env.TAGMAILS_CLAUDE_SESSION_FILE };
  process.env.TAGMAILS_WORKSPACE = workspace;
  process.env.TAGMAILS_CLAUDE_SESSION_FILE = path.join(workspace, 'sessions.json');
  t.after(() => {
    if (previous.workspace === undefined) delete process.env.TAGMAILS_WORKSPACE;
    else process.env.TAGMAILS_WORKSPACE = previous.workspace;
    if (previous.store === undefined) delete process.env.TAGMAILS_CLAUDE_SESSION_FILE;
    else process.env.TAGMAILS_CLAUDE_SESSION_FILE = previous.store;
  });
  await assert.rejects(runClaim(claim('job-1')), /session store must be outside/);
});

test('each Claude permission mode maps to its CLI flags, and bypass is owner-only', async () => {
  const { MODES, selectedMode } = await import('./claude-runner.mjs');
  assert.equal(selectedMode({ TAGMAILS_CLAUDE_PERMISSION: 'auto' }), 'auto');
  assert.equal(selectedMode({ TAGMAILS_CLAUDE_PERMISSION: 'plan' }), 'readonly');
  assert.equal(selectedMode({ TAGMAILS_RUNTIME: 'claude-write' }), 'acceptEdits');
  assert.deepEqual(Object.keys(MODES).sort(), ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'readonly']);
  assert.equal(MODES.manual.write, false);
  assert.equal(MODES.bypassPermissions.restricted, false);
  assert.equal(MODES.bypassPermissions.ownerOnly, true);
  assert.equal(MODES.acceptEdits.tools.includes('Bash'), false);
});

test('owner connector rules name each MCP server', async () => {
  const { mcpAllowRules } = await import('./claude-runner.mjs');
  assert.deepEqual(mcpAllowRules('Checking MCP server health…\n\nclaude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✔ Connected\nblender: uvx blender-mcp - ✗ Failed to connect\n'),
    ['--allowedTools', 'mcp__claude_ai_Google_Drive__*', 'mcp__blender__*']);
  assert.deepEqual(mcpAllowRules('No MCP servers configured.'), []);
});
