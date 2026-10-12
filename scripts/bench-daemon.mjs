// Times each stage of an email's life on this machine, with real clocks.
//
//   node scripts/bench-daemon.mjs [--runs 20] [--only relay,adapter,codex,claude] [--json out.json]
//
// - relay:   accept → claim → complete → outbox send, in-process against the
//            same SQLite schema D1 runs (bindings fixture), with the number of
//            D1 statements each stage issues. Network latency to D1/R2 is not
//            included; statement counts are what scale with it.
// - adapter: the daemon's per-job work outside the model: spawn the Node
//            adapter exactly as the daemon does (claim on stdin), owner Codex
//            and owner Claude (auto) runs, with fake CLIs that answer at once.
// - codex:   the real `codex app-server` handshake each run does
//            (initialize, config/read, model/list), read-only.
// - claude:  the real `claude mcp list` an owner Claude run does, and
//            `claude --version` as the CLI's bare startup.
// Nothing here sends mail or calls a model.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const RUNS = Number(arg('runs', '20'));
const ONLY = new Set(String(arg('only', 'relay,adapter,codex,claude')).split(','));
const results = {};

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { n: sorted.length, p50: Math.round(at(0.5)), p95: Math.round(at(0.95)) };
}

function record(stage, samples, extra = {}) {
  results[stage] = { ...stats(samples), ...extra };
  const { n, p50, p95 } = results[stage];
  console.log(`${stage.padEnd(34)} p50 ${String(p50).padStart(6)} ms   p95 ${String(p95).padStart(6)} ms   n=${n}${
    Object.keys(extra).length ? `   ${JSON.stringify(extra)}` : ''}`);
}

async function timed(work) {
  const start = performance.now();
  const value = await work();
  return { ms: performance.now() - start, value };
}

function onPath(program) {
  try { execFileSync('which', [program], { stdio: 'ignore' }); return true; } catch { return false; }
}

// --- relay -------------------------------------------------------------------

async function relayBench() {
  const { bindings } = await import(path.join(root, 'services/bindings-fixture.mjs'));
  const { handleInbound } = await import(path.join(root, 'services/relay-worker.mjs'));
  const { handleDeviceRequest } = await import(path.join(root, 'services/device-jobs.mjs'));
  const { sendNextOutbox } = await import(path.join(root, 'services/outbox.mjs'));
  const { createHash, randomBytes } = await import('node:crypto');
  const stages = { accept: [], claim: [], complete: [], send: [] };
  const counts = { accept: [], claim: [], complete: [], send: [] };
  for (let run = 0; run < RUNS; run += 1) {
    const { env, sqlite } = bindings();
    let statements = 0;
    const prepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = (sql) => { statements += 1; return prepare(sql); };
    const token = `tm_dev_${randomBytes(32).toString('base64url')}`;
    sqlite.prepare('INSERT INTO devices (id, account_id, token_hash) VALUES (?, ?, ?)')
      .run('device-1', 'account-1', createHash('sha256').update(token).digest('hex'));
    const device = (pathname, body) => handleDeviceRequest(new Request(`https://relay.test/api/device/${pathname}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}) }), env).then((response) => response.json());
    const measure = async (stage, work) => {
      statements = 0;
      const { ms, value } = await timed(work);
      stages[stage].push(ms);
      counts[stage].push(statements);
      return value;
    };
    const messageId = `<bench-${run}@gmail.com>`;
    const rawMime = Buffer.from(['From: owner@gmail.com', 'To: agent@wonder.test', 'Subject: Bench',
      `Message-ID: ${messageId}`, 'Content-Type: text/plain; charset=utf-8', '', 'Model: Luna\nSummarize the repo.'].join('\r\n'));
    const message = { providerEmailId: `bench-${run}`, messageId, from: 'owner@gmail.com', agentAddress: 'agent@wonder.test',
      to: ['agent@wonder.test'], cc: [], bcc: [], subject: 'Bench', parentIds: [], rawMime, body: 'Model: Luna\nSummarize the repo.' };
    await measure('accept', () => handleInbound(new Request('https://relay.test/webhooks/resend', { method: 'POST', body: '{}' }),
      env, { inspect: async () => message }));
    const claim = await measure('claim', () => device('claim'));
    const job = JSON.parse(Buffer.from(claim.payload, 'base64url').toString('utf8'));
    await measure('complete', () => device('complete', { jobId: job.jobId, leaseId: job.leaseId,
      result: { state: 'completed', summary: 'Done.', answer: 'The repo is a relay and a daemon.' } }));
    await measure('send', () => sendNextOutbox(env, { sendEmail: async () => ({ data: { id: `sent-${run}` } }),
      getSentEmail: async (id) => ({ data: { message_id: `<${id}@tagmails.test>` } }) }));
  }
  for (const stage of Object.keys(stages)) {
    record(`relay ${stage}`, stages[stage], { d1Statements: stats(counts[stage]).p50 });
  }
}

// --- adapter -----------------------------------------------------------------

const FAKE_CODEX = `#!/usr/bin/env node
const readline = require('node:readline');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: {} });
  if (m.method === 'config/read') send({ id: m.id, result: { config: { web_search: 'disabled', sandbox_mode: null }, layers: [] } });
  if (m.method === 'model/list') send({ id: m.id, result: { data: [{ id: 'gpt-6-luna',
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }], serviceTiers: [] }] } });
  if (m.method === 'account/read') send({ id: m.id, result: { account: { type: 'chatgpt', email: 'owner@gmail.com' } } });
  if (m.method === 'account/rateLimits/read') send({ id: m.id, result: { rateLimits: {} } });
  if (m.method === 'thread/start' || m.method === 'thread/resume') send({ id: m.id, result: { thread: { id: '11111111-1111-4111-8111-111111111111' },
    activePermissionProfile: { id: m.params.permissions } } });
  if (m.method === 'thread/turns/list' || m.method === 'thread/items/list') send({ id: m.id, result: { data: [], nextCursor: null } });
  if (m.method === 'turn/start') {
    send({ id: m.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
    send({ method: 'item/completed', params: { item: { type: 'agentMessage', phase: 'final_answer', text: 'Done.' } } });
    send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  }
});
`;

const FAKE_CLAUDE = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'mcp' && args[1] === 'list') {
  // The adapter passes no custom env to the CLI, so the simulated health-check time comes from a file beside it.
  const delay = Number(require('node:fs').readFileSync(require('node:path').join(__dirname, 'mcp-list-ms'), 'utf8'));
  setTimeout(() => process.stdout.write('Checking MCP server health…\\n\\nclaude.ai Gmail: https://gmail.mcp.claude.com/mcp - ✔ Connected\\n'), delay);
} else {
  let started = false;
  process.stdin.on('data', () => {
    if (started) return;
    started = true;
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
      session_id: '33333333-3333-4333-8333-333333333333', result: 'Done.' }) + '\\n');
  });
}
`;

function runAdapter(script, claim, env) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn(process.execPath, [path.join(root, 'agent', script)], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', () => {
      const ms = performance.now() - start;
      try {
        const result = JSON.parse(out);
        if (result.state !== 'completed') throw new Error(`${result.state}: ${result.summary} ${err}`);
        resolve(ms);
      } catch (error) { reject(new Error(`${script}: ${error.message} ${err}`)); }
    });
    child.stdin.end(JSON.stringify(claim));
  });
}

async function adapterBench() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tagmails-bench-'));
  try {
    const workspace = path.join(base, 'workspace');
    fs.mkdirSync(workspace);
    execFileSync('git', ['init', '-q', workspace]);
    for (const [name, body] of [['fake-codex', FAKE_CODEX], ['fake-claude', FAKE_CLAUDE]]) {
      fs.writeFileSync(path.join(base, name), body, { mode: 0o755 });
    }
    // Measured: the real `claude mcp list` takes ~3.5 s (see the claude stage).
    fs.writeFileSync(path.join(base, 'mcp-list-ms'), arg('mcp-list-ms', '3500'));
    fs.mkdirSync(path.join(base, 'codex-desktop'));
    fs.writeFileSync(path.join(base, 'codex-desktop', 'auth.json'), '{}', { mode: 0o600 });
    const env = {
      PATH: process.env.PATH, HOME: base, TMPDIR: os.tmpdir(), TAGMAILS_WORKSPACE: workspace,
      TAGMAILS_CONFIG_DIR: path.join(base, 'config'), TAGMAILS_CODEX_BIN: path.join(base, 'fake-codex'),
      TAGMAILS_CLAUDE_BIN: path.join(base, 'fake-claude'), TAGMAILS_CODEX_DESKTOP_HOME: path.join(base, 'codex-desktop'),
      TAGMAILS_CODEX_OWNER_HOME: path.join(base, 'codex-owner'), TAGMAILS_CLAUDE_SESSION_FILE: path.join(base, 'claude-sessions.json'),
      TAGMAILS_LAB_URL: 'http://127.0.0.1:9', TAGMAILS_CLAUDE_MCP_CACHE: path.join(base, 'mcp-cache.json'),
    };
    const claim = (run, model) => ({ claimed: true, jobId: `bench-${model}-${run}`, claimId: `lease-${run}`, threadId: `thread-${model}-${run}`,
      model: { id: model, effort: 'medium' }, request: { from: 'owner@gmail.com', fromOwner: true, subject: 'Bench', body: 'Summarize.', attachments: [] } });
    const importOnly = [];
    for (let run = 0; run < RUNS; run += 1) {
      importOnly.push((await timed(() => new Promise((resolve) => spawn(process.execPath,
        ['--input-type=module', '-e', `await import(${JSON.stringify(path.join(root, 'agent/claude-runner.mjs'))})`],
        { stdio: 'ignore' }).on('close', resolve)))).ms);
    }
    record('adapter node start + import', importOnly);
    const codex = [];
    const claude = [];
    for (let run = 0; run < RUNS; run += 1) {
      codex.push(await runAdapter('codex-runner.mjs', claim(run, 'gpt-6-luna'), { ...env, TAGMAILS_RUNTIME: 'codex-write' }));
      claude.push(await runAdapter('claude-runner.mjs', claim(run, 'claude-sonnet-5-5'),
        { ...env, TAGMAILS_RUNTIME: 'claude-write', TAGMAILS_CLAUDE_PERMISSION: 'auto' }));
    }
    record('adapter owner Codex run (fake CLI)', codex);
    record('adapter owner Claude run (fake CLI)', claude);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
}

// --- real CLIs ---------------------------------------------------------------

async function codexBench() {
  if (!onPath('codex')) { console.log('codex: not installed, skipped'); return; }
  const samples = { spawnToInitialize: [], configRead: [], modelList: [] };
  for (let run = 0; run < Math.min(RUNS, 10); run += 1) {
    const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const pending = new Map();
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try { const message = JSON.parse(line); pending.get(message.id)?.(message); } catch { /* Not JSON. */ }
      }
    });
    let id = 0;
    const request = (method, params) => new Promise((resolve) => {
      id += 1;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    const start = performance.now();
    await request('initialize', { clientInfo: { name: 'tagmails-bench', title: 'bench', version: '0' } });
    samples.spawnToInitialize.push(performance.now() - start);
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    samples.configRead.push((await timed(() => request('config/read', { cwd: root, includeLayers: true }))).ms);
    samples.modelList.push((await timed(() => request('model/list', { includeHidden: false, limit: 100 }))).ms);
    child.kill();
  }
  record('codex app-server spawn → initialize', samples.spawnToInitialize);
  record('codex config/read', samples.configRead);
  record('codex model/list', samples.modelList);
}

async function claudeBench() {
  if (!onPath('claude')) { console.log('claude: not installed, skipped'); return; }
  const list = [];
  const version = [];
  for (let run = 0; run < Math.min(RUNS, 5); run += 1) {
    list.push((await timed(() => new Promise((resolve) => spawn('claude', ['mcp', 'list'], { stdio: 'ignore' }).on('close', resolve)))).ms);
    version.push((await timed(() => new Promise((resolve) => spawn('claude', ['--version'], { stdio: 'ignore' }).on('close', resolve)))).ms);
  }
  record('claude mcp list (owner run prep)', list);
  record('claude --version (CLI startup)', version);
}

if (ONLY.has('relay')) await relayBench();
if (ONLY.has('adapter')) await adapterBench();
if (ONLY.has('codex')) await codexBench();
if (ONLY.has('claude')) await claudeBench();
const out = arg('json');
if (out) fs.writeFileSync(out, `${JSON.stringify({ at: new Date().toISOString(), runs: RUNS, results }, null, 2)}\n`);
