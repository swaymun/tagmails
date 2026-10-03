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

function setup(t, mode = 'normal') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tagmails-codex-test-'));
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'codex-home');
  const auth = path.join(root, 'auth.json');
  const calls = path.join(root, 'calls.jsonl');
  const fakeBin = path.join(root, 'fake-codex');
  fs.mkdirSync(workspace);
  fs.writeFileSync(auth, '{"fake":true}\n', { mode: 0o600 });
  fs.writeFileSync(fakeBin, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const log = ${JSON.stringify(calls)};
const mode = ${JSON.stringify(mode)};
const id = '11111111-1111-4111-8111-111111111111';
let resumed = false;
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === 900 && message.result) fs.appendFileSync(log,
    JSON.stringify({ method: 'approval-response', decision: message.result.decision }) + '\\n');
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  if (message.method === 'config/read') send({ id: message.id, result: {
    config: { web_search: 'disabled', sandbox_mode: null, mcp_servers: mode === 'external-tool' ? { rogue: {} } : {} },
    layers: [{ name: { type: 'project' }, disabledReason: mode === 'trusted-project' ? null : 'untrusted' }],
  } });
  if (message.method === 'model/list') send({ id: message.id, result: { data: [
    { id: 'gpt-6-luna', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'].map(reasoningEffort => ({ reasoningEffort })),
      serviceTiers: [{ id: 'priority', name: 'Fast' }] },
    { id: 'gpt-6-sol', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(reasoningEffort => ({ reasoningEffort })),
      serviceTiers: [{ id: 'priority', name: 'Fast' }] },
    ...(mode === 'missing-6.1' ? [] : [
    { id: 'gpt-6.1-sol', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(reasoningEffort => ({ reasoningEffort })),
      serviceTiers: [{ id: 'priority', name: 'Fast' }] },
    ]),
  ] } });
  if (message.method === 'account/read') send({ id: message.id, result: {
    account: { type: 'chatgpt', email: mode === 'account-mismatch' ? 'another@gmail.com' : 'owner@gmail.com', planType: 'pro' },
  } });
  if (message.method === 'account/rateLimits/read') send({ id: message.id, result: {
    rateLimits: { primary: { usedPercent: 34, windowDurationMins: 10080,
      resetsAt: Math.floor(Date.now() / 1000) + 86400 } },
  } });
  if (message.method === 'thread/turns/list') {
    send({ id: message.id, result: { data: [{ id: mode === 'history-wrong-turn' ? 'older-turn' : 'turn-1',
      status: 'completed', items: [
        { type: 'userMessage', content: [{ type: 'text', text: 'SECRET_PROMPT' }] },
        { type: 'agentMessage', phase: mode === 'legacy-phase' ? undefined : 'final_answer',
          text: mode === 'legacy-phase' ? 'First turn.' : 'Recovered answer.' },
      ] }] } });
  }
  if (message.method === 'thread/items/list') {
    const turnId = mode === 'history-wrong-turn' ? 'older-turn' : 'turn-1';
    const finalText = ['missing-final-event', 'unphased-progress'].includes(mode) ? 'Recovered answer.'
      : resumed ? 'First turn plus second turn.' : 'First turn.';
    const entries = [
      { turnId, item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'SECRET_PROMPT' }] } },
      { turnId, item: { id: 'reason-1', type: 'reasoning',
        summary: mode === 'reasoning-summary' ? ['Checked available files.'] : 'SECRET_REASONING',
        content: ['SECRET_PRIVATE_REASONING'] } },
      { turnId, item: { id: 'command-1', type: 'commandExecution', command: 'cat secret.txt',
        aggregatedOutput: 'SECRET_FILE', status: 'completed', exitCode: 0 } },
      { turnId, item: { id: 'message-1', type: 'agentMessage', phase: 'commentary', text: 'Checking the workspace.' } },
      { turnId, item: { id: 'message-2', type: 'agentMessage',
        phase: mode === 'legacy-phase' ? undefined : 'final_answer', text: finalText } },
    ];
    if (mode === 'history-paged' && !message.params.cursor) send({ id: message.id,
      result: { data: entries.slice(0, 4), nextCursor: 'page-2' } });
    else if (mode === 'history-paged') send({ id: message.id,
      result: { data: [entries[3], entries[4]], nextCursor: null } });
    else if (mode === 'history-repeated-cursor') send({ id: message.id,
      result: { data: entries.slice(0, 2), nextCursor: 'repeat' } });
    else send({ id: message.id, result: { data: entries, nextCursor: null } });
  }
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    resumed = message.method === 'thread/resume';
    fs.appendFileSync(log, JSON.stringify({ method: message.method, params: message.params,
      codexHome: process.env.CODEX_HOME, hadApiKey: Boolean(process.env.OPENAI_API_KEY) }) + '\\n');
    send({ id: message.id, result: { thread: { id }, activePermissionProfile: {
      id: mode === 'wrong-profile' ? ':danger-full-access' : message.params.permissions } } });
  }
  if (message.method === 'turn/start') {
    const prompt = message.params.input[0].text;
    const attachmentLine = prompt.split(String.fromCharCode(10)).find(line => line.startsWith('1. /'));
    const attachment = attachmentLine?.split(' (')[0].slice(3);
    const attachmentText = attachment ? fs.readFileSync(attachment, 'utf8') : null;
    fs.appendFileSync(log, JSON.stringify({ method: message.method, params: message.params,
      attachment, attachmentText }) + '\\n');
    if (mode === 'abrupt-write') {
      fs.writeFileSync('partial.txt', 'one local edit\\n');
      process.exit(17);
    }
    send({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
    if (mode === 'approval-request') send({ id: 900, method: 'item/commandExecution/requestApproval',
      params: { threadId: id, turnId: 'turn-1', command: 'curl https://example.com' } });
    setTimeout(() => {
      send({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { last: {
        inputTokens: 1200, cachedInputTokens: 300, cacheWriteInputTokens: 0,
        outputTokens: 40, reasoningOutputTokens: 12 } } } });
      send({ method: 'item/completed', params: { item: { type: 'reasoning',
        summary: mode === 'reasoning-summary' ? ['Checked available files.'] : 'SECRET_REASONING',
        content: ['SECRET_PRIVATE_REASONING'] } } });
      send({ method: 'item/completed', params: { item: { type: 'commandExecution', command: 'cat secret.txt',
        aggregatedOutput: 'SECRET_FILE', status: 'completed', exitCode: 0 } } });
      if (mode !== 'history-paged') send({ method: 'item/completed', params: { item: { type: 'agentMessage',
        ...(mode === 'unphased-progress' ? {} : { phase: 'commentary' }), text: 'Checking the workspace.' } } });
      if (!['missing-final-event', 'history-wrong-turn', 'unphased-progress'].includes(mode)) send({ method: 'item/completed', params: { item: { type: 'agentMessage',
        ...(mode === 'legacy-phase' ? {} : { phase: 'final_answer' }),
        text: resumed ? 'First turn plus second turn.' : 'First turn.' } } });
      send({ method: 'turn/completed', params: { turn: { status: mode === 'turn-failed' ? 'failed' : 'completed' } } });
    }, mode === 'slow' ? 160 : mode === 'approval-request' ? 20 : 0);
  }
});
`, { mode: 0o755 });
  const keys = ['TAGMAILS_WORKSPACE', 'TAGMAILS_SESSION_FILE', 'TAGMAILS_CODEX_BIN',
    'TAGMAILS_CODEX_AUTH_FILE', 'TAGMAILS_CODEX_RUNTIME_HOME', 'OPENAI_API_KEY'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    TAGMAILS_WORKSPACE: workspace,
    TAGMAILS_SESSION_FILE: path.join(root, 'sessions.json'),
    TAGMAILS_CODEX_BIN: fakeBin,
    TAGMAILS_CODEX_AUTH_FILE: auth,
    TAGMAILS_CODEX_RUNTIME_HOME: home,
    OPENAI_API_KEY: 'FAKE_TEST_KEY',
  });
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, workspace, home, auth, calls };
}

test('Codex app-server resumes the restricted thread, reads an attachment, and caches results', async (t) => {
  const { root, workspace, home, auth, calls } = setup(t);
  const attached = claim('job-1', 'thread-1');
  attached.request.fromOwner = true;
  attached.request.attachments = [{ name: 'note.txt', mimeType: 'text/plain', size: 16,
    data: Buffer.from('Agent test note.').toString('base64') }];
  const first = await runClaim(attached);
  assert.equal(first.state, 'completed');
  assert.match(first.summary, /First turn/);
  assert.deepEqual(first.usage, { inputTokens: 1200, cachedInputTokens: 300,
    cacheCreationInputTokens: 0, outputTokens: 40, reasoningOutputTokens: 12 });
  assert.equal(first.codexAllowance.windows[0].remainingPercent, 66);
  assert.deepEqual(first.transcript.events, [
    { kind: 'request', text: 'Summarize this workspace.' },
    { kind: 'tool', text: 'Local command completed (exit 0).' },
    { kind: 'assistant', phase: 'commentary', text: 'Checking the workspace.' },
    { kind: 'assistant', phase: 'final_answer', text: 'First turn.' },
  ]);
  assert.doesNotMatch(JSON.stringify(first.transcript), /SECRET_REASONING|SECRET_FILE|secret\.txt/);
  assert.deepEqual(await runClaim(claim('job-1', 'thread-1')), first);
  const second = await runClaim(claim('job-2', 'thread-1', 'Continue the summary.'));
  assert.match(second.summary, /second turn/);

  const events = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.length, 4);
  assert.equal(events[0].params.permissions, 'tagmails-read');
  assert.equal(events[0].hadApiKey, false);
  assert.equal(events[0].codexHome, fs.realpathSync(home));
  assert.equal(events[1].params.cwd, fs.realpathSync(workspace));
  assert.equal(events[1].params.sandboxPolicy, undefined);
  assert.equal(events[1].attachmentText, 'Agent test note.');
  assert.equal(events[1].attachment.startsWith(fs.realpathSync(workspace)), true);
  assert.equal(fs.existsSync(events[1].attachment), false);
  assert.equal(events[2].method, 'thread/resume');
  assert.equal(events[2].params.threadId, '11111111-1111-4111-8111-111111111111');
  assert.equal(events[2].params.permissions, 'tagmails-read');
  assert.ok(events[3].params.input[0].text.includes('Continue the summary.'));
  assert.equal(fs.realpathSync(path.join(home, 'auth.json')), fs.realpathSync(auth));
  assert.match(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), /":root" = "deny"/);
  const store = JSON.parse(fs.readFileSync(path.join(root, 'sessions.json'), 'utf8'));
  assert.equal(store.threads['thread-1'].sessionId, '11111111-1111-4111-8111-111111111111');
  assert.equal(Object.keys(store.jobs).length, 2);
});

test('a different Codex account does not disclose its allowance to the Gmail owner', async (t) => {
  setup(t, 'account-mismatch');
  const ownerClaim = claim('job-account-mismatch', 'thread-account-mismatch');
  ownerClaim.request.fromOwner = true;
  const result = await runClaim(ownerClaim);
  assert.equal(result.state, 'completed');
  assert.equal(result.codexAllowance, undefined);
});

test('Codex passes advertised effort and fast tier and records reasoning summaries', async (t) => {
  const { calls } = setup(t, 'reasoning-summary');
  const job = claim('job-fast', 'thread-fast');
  job.model = { id: 'gpt-6-luna', effort: 'medium', speed: 'fast' };
  const result = await runClaim(job);
  assert.equal(result.state, 'completed');
  assert.deepEqual(result.transcript.events[1], { kind: 'reasoning', text: 'Checked available files.' });
  assert.doesNotMatch(JSON.stringify(result.transcript), /SECRET_PRIVATE_REASONING/);
  const turn = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse).find((item) => item.method === 'turn/start');
  assert.equal(turn.params.effort, 'medium');
  assert.equal(turn.params.serviceTierForTurn, 'priority');
});

test('Codex rejects a speed tier missing from its live model catalog', async (t) => {
  const { calls } = setup(t);
  const job = claim('job-ultrafast', 'thread-ultrafast');
  job.model.speed = 'ultrafast';
  const result = await runClaim(job);
  assert.equal(result.state, 'needs_clarification');
  assert.match(result.summary, /does not offer ultrafast speed/);
  assert.equal(fs.existsSync(calls), false);
});

test('Codex runs listed Sol and gives a no-charge clarification for absent 6.1', async (t) => {
  const { calls } = setup(t, 'missing-6.1');
  const unavailable = claim('job-sol61', 'thread-sol61');
  unavailable.model = { id: 'gpt-6.1-sol', effort: 'medium' };
  const notice = await runClaim(unavailable);
  assert.equal(notice.state, 'needs_clarification');
  assert.match(notice.summary, /not available on this Mac/);
  assert.equal(fs.existsSync(calls), false);
  const available = claim('job-sol6', 'thread-sol6');
  available.model = { id: 'gpt-6-sol', effort: 'medium' };
  const result = await runClaim(available);
  assert.equal(result.state, 'completed');
  const turn = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse)
    .find((item) => item.method === 'turn/start');
  assert.equal(turn.params.model, 'gpt-6-sol');
  assert.equal(turn.params.effort, 'medium');
});

test('Codex adapter accepts an unphased legacy answer as the final response', async (t) => {
  setup(t, 'legacy-phase');
  const result = await runClaim(claim('job-legacy', 'thread-legacy'));
  assert.equal(result.state, 'completed');
  assert.equal(result.summary, 'First turn.');
  assert.deepEqual(result.transcript.events.at(-1), {
    kind: 'assistant', phase: 'final_answer', text: 'First turn.',
  });
});

test('Codex adapter recovers a missed final event from the completed turn summary', async (t) => {
  setup(t, 'missing-final-event');
  const result = await runClaim(claim('job-history', 'thread-history'));
  assert.equal(result.state, 'completed');
  assert.equal(result.summary, 'Recovered answer.');
  assert.deepEqual(result.transcript.events.at(-1), {
    kind: 'assistant', phase: 'final_answer', text: 'Recovered answer.',
  });
  assert.doesNotMatch(JSON.stringify(result), /SECRET_PROMPT/);
});

test('Codex history fills a missed progress event across pages without leaking raw items', async (t) => {
  setup(t, 'history-paged');
  const result = await runClaim(claim('job-paged', 'thread-paged'));
  assert.equal(result.state, 'completed');
  assert.deepEqual(result.transcript.events, [
    { kind: 'request', text: 'Summarize this workspace.' },
    { kind: 'tool', text: 'Local command completed (exit 0).' },
    { kind: 'assistant', phase: 'commentary', text: 'Checking the workspace.' },
    { kind: 'assistant', phase: 'final_answer', text: 'First turn.' },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_PROMPT|SECRET_REASONING|SECRET_FILE|secret\.txt/);
});

test('a repeated Codex history cursor leaves the live transcript intact', async (t) => {
  setup(t, 'history-repeated-cursor');
  const result = await runClaim(claim('job-cursor', 'thread-cursor'));
  assert.equal(result.state, 'completed');
  assert.equal(result.transcript.events.at(-1).text, 'First turn.');
  assert.equal(result.transcript.events.some((event) => event.text === 'Checking the workspace.'), true);
});

test('an unphased progress message does not replace a saved final answer', async (t) => {
  setup(t, 'unphased-progress');
  const result = await runClaim(claim('job-unphased', 'thread-unphased'));
  assert.equal(result.state, 'completed');
  assert.equal(result.summary, 'Recovered answer.');
  assert.deepEqual(result.transcript.events.at(-1), {
    kind: 'assistant', phase: 'final_answer', text: 'Recovered answer.',
  });
});

test('Codex adapter does not use a different turn as its final answer', async (t) => {
  setup(t, 'history-wrong-turn');
  const result = await runClaim(claim('job-wrong-history', 'thread-wrong-history'));
  assert.equal(result.state, 'failed');
  assert.match(result.summary, /without a readable answer/);
});

test('Codex adapter refuses to run a turn when the restricted profile is not active', async (t) => {
  const { calls } = setup(t, 'wrong-profile');
  await assert.rejects(runClaim(claim('job-1', 'thread-1')), /tagmails-read profile/);
  const events = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.length, 1);
});

test('Codex adapter rejects active project settings before starting a thread', async (t) => {
  setup(t, 'trusted-project');
  await assert.rejects(runClaim(claim('job-1', 'thread-1')), /active project settings/);
});

test('Codex adapter rejects external tools before starting a thread', async (t) => {
  setup(t, 'external-tool');
  await assert.rejects(runClaim(claim('job-1', 'thread-1')), /external tools/);
});

test('Codex adapter keeps the session store outside the readable workspace', async (t) => {
  const { workspace } = setup(t);
  process.env.TAGMAILS_SESSION_FILE = path.join(workspace, 'sessions.json');
  await assert.rejects(runClaim(claim('job-1', 'thread-1')), /session store must be outside/);
});

test('a longer Codex app-server turn renews its lab claim', async (t) => {
  setup(t, 'slow');
  let renewals = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/api/renew') renewals++;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"renewed":true}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const previous = { url: process.env.TAGMAILS_LAB_URL, interval: process.env.TAGMAILS_CLAIM_RENEW_MS };
  process.env.TAGMAILS_LAB_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.TAGMAILS_CLAIM_RENEW_MS = '20';
  t.after(() => {
    if (previous.url === undefined) delete process.env.TAGMAILS_LAB_URL;
    else process.env.TAGMAILS_LAB_URL = previous.url;
    if (previous.interval === undefined) delete process.env.TAGMAILS_CLAIM_RENEW_MS;
    else process.env.TAGMAILS_CLAIM_RENEW_MS = previous.interval;
  });
  assert.equal((await runClaim(claim('job-slow', 'thread-slow'))).state, 'completed');
  assert.ok(renewals >= 1);
});

test('opt-in Codex write mode uses its restricted profile and prompt', async (t) => {
  const { workspace, home, calls } = setup(t);
  const result = await runClaim(claim('job-write', 'thread-write', 'Edit a file in this workspace.'), { write: true });
  assert.equal(result.state, 'completed');
  assert.equal(result.runtime, 'codex-app-server-write');
  assert.match(result.checks[0], /selected-workspace writes and no command network/);
  const events = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events[0].params.permissions, 'tagmails-write');
  assert.equal(events[1].params.cwd, fs.realpathSync(workspace));
  assert.match(events[1].params.input[0].text, /You may read and change files only in the selected workspace/);
  assert.match(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), /"\." = "write"/);
});

test('full Codex access requires the verified owner and activates the full profile', async (t) => {
  const { home, calls } = setup(t);
  const task = claim('job-full', 'thread-full', 'Read the workspace note.');
  task.request.fromOwner = false;
  assert.equal((await runClaim(task, { full: true })).state, 'needs_clarification');
  assert.equal(fs.existsSync(calls), false);
  task.request.fromOwner = true;
  const result = await runClaim(task, { full: true });
  assert.equal(result.state, 'completed');
  assert.equal(result.runtime, 'codex-app-server-full');
  const events = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events[0].params.permissions, ':danger-full-access');
  assert.equal(events[0].params.approvalPolicy, 'never');
  assert.equal(events[1].params.approvalPolicy, 'never');
  assert.match(events[1].params.input[0].text, /full local file and network access/);
  assert.match(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), /default_permissions = ":danger-full-access"/);
});

test('Codex write mode declines access expansion and reports a waiting result', async (t) => {
  const { calls } = setup(t, 'approval-request');
  const result = await runClaim(claim('job-approval', 'thread-approval', 'Use the network.'), { write: true });
  assert.equal(result.state, 'needs_approval');
  assert.equal(result.runtime, 'codex-app-server-write');
  assert.match(result.checks.join(' '), /request\(s\) to expand permissions were declined/);
  assert.match(result.checks.join(' '), /Local edits may already have occurred/);
  const events = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.find((item) => item.method === 'approval-response')?.decision, 'decline');
});

test('a failed Codex turn retains only the visible partial run transcript', async (t) => {
  setup(t, 'turn-failed');
  const result = await runClaim(claim('job-failed', 'thread-failed'));
  assert.equal(result.state, 'failed');
  assert.deepEqual(result.transcript.events, [
    { kind: 'request', text: 'Summarize this workspace.' },
    { kind: 'tool', text: 'Local command completed (exit 0).' },
    { kind: 'assistant', phase: 'commentary', text: 'Checking the workspace.' },
  ]);
  assert.doesNotMatch(JSON.stringify(result.transcript), /SECRET_REASONING|SECRET_FILE|secret\.txt/);
});

test('an interrupted Codex write is not executed a second time for the same email', async (t) => {
  const { root, workspace, calls } = setup(t, 'abrupt-write');
  const job = claim('job-interrupted', 'thread-interrupted', 'Edit a file in this workspace.');
  await assert.rejects(runClaim(job, { write: true }), /exited with 17/);
  assert.equal(fs.readFileSync(path.join(workspace, 'partial.txt'), 'utf8'), 'one local edit\n');
  const result = await runClaim(job, { write: true });
  assert.equal(result.state, 'failed');
  assert.match(result.summary, /previous local write attempt stopped/i);
  assert.match(result.checks[0], /local edits may remain/);
  assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').filter((line) =>
    JSON.parse(line).method === 'turn/start').length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'sessions.json'))).jobs[job.jobId], result);
});
