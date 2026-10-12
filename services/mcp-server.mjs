import { accountDevices, createPairingCode, revokeAccountDevice } from './account-auth.mjs';
import { accountPreferences } from './account-preferences.mjs';
import { startCheckout, TOP_UP_CENTS } from './billing-wallet.mjs';
import { billingLive, emailPriceMillicents, testBillingEnabled, testWalletSnapshot } from './email-charges.mjs';
import { selectedModelStatus } from './model-route.mjs';
import { selectedRunArtifacts } from './run-artifacts.mjs';
import { openText } from './storage-crypto.mjs';
import { MCP_SCOPES, mcpGrantFor, OPEN_CORS, resourceMetadataUrl } from './mcp-oauth.mjs';
import { rateLimited, rateLimitedKey, tooManyRequests } from './rate-limit.mjs';

// A plain remote MCP server (streamable HTTP, stateless, JSON responses only)
// for setting up and checking TagMails from Codex, Claude Code, Claude or
// ChatGPT. Every tool acts on the one account behind the OAuth grant.

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
// The daemon pairs with this relay unless told otherwise (DEFAULT_RELAY in crates/tagmails-daemon).
const HOSTED_RELAY = 'https://tagmails-relay-dev.saimun-shahee.workers.dev';
const UUID = /^[0-9a-f-]{36}$/i;
const MAX_BODY = 64_000;
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const SPEEDS = ['standard', 'fast', 'ultrafast'];
const DEFAULT_MODELS = { codex: 'gpt-6-sol', claude: 'claude-sonnet-5-5' };
const [READ, MANAGE] = MCP_SCOPES;

class ToolError extends Error {}

const harnessOf = (model) => String(model ?? '').startsWith('claude-') ? 'claude' : 'codex';

function dollars(millicents) {
  const value = (millicents / 100_000).toFixed(5).replace(/0+$/, '');
  return `$${value.split('.')[1]?.length >= 2 ? value : Number(value).toFixed(2)}`;
}

function minutesSince(timestamp) {
  const time = Date.parse(`${String(timestamp ?? '').replace(' ', 'T')}Z`);
  return Number.isFinite(time) ? (Date.now() - time) / 60_000 : null;
}

// Subjects may be sealed; a value the relay can't open is left out, not fatal.
async function readableText(env, value) {
  try { return await openText(env, value); } catch { return null; }
}

function projectName(workspaceJson) {
  try { return JSON.parse(workspaceJson ?? 'null')?.name ?? null; } catch { return null; }
}

function configuredOrigin(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    return url.protocol === 'https:' && url.pathname === '/' && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}

async function wallet(env, accountId) {
  const snapshot = await testWalletSnapshot(env, accountId);
  const enabled = Boolean(testBillingEnabled(env));
  return { balance: dollars(snapshot.balanceCents * 1000), balanceCents: snapshot.balanceCents,
    waitingEmails: enabled ? snapshot.waitingEmails : 0, pricePerEmail: dollars(emailPriceMillicents(env)),
    topUpsEnabled: enabled, testMode: enabled && !billingLive(env) };
}

async function recentRuns(env, ctx, { limit, threadId = null }) {
  const rows = await env.DB.prepare(`SELECT j.id, j.thread_id, j.state, j.created_at, j.model_json, j.workspace_json,
    t.subject, m.sender_email, o.state AS delivery_state
    FROM jobs j JOIN threads t ON t.id = j.thread_id JOIN messages m ON m.id = j.message_id
    LEFT JOIN outbox o ON o.job_id = j.id
    WHERE t.account_id = ? AND (? IS NULL OR j.thread_id = ?)
    ORDER BY j.created_at DESC, j.rowid DESC LIMIT ?`).bind(ctx.account.id, threadId, threadId, limit).all();
  return Promise.all((rows.results ?? rows).map(async (row) => ({
    id: row.id, threadId: row.thread_id, state: row.state, createdAt: row.created_at,
    subject: await readableText(env, row.subject), from: row.sender_email, project: projectName(row.workspace_json),
    model: selectedModelStatus(row.model_json), delivery: row.delivery_state ?? null,
    receiptUrl: `${ctx.origin}/runs/${row.id}`,
  })));
}

async function connections(env, ctx) {
  const rows = await env.DB.prepare(`SELECT g.id, g.created_at, g.last_used_at, c.name FROM mcp_grants g
    JOIN mcp_clients c ON c.id = g.client_id
    WHERE g.account_id = ? AND g.revoked_at IS NULL ORDER BY g.created_at DESC LIMIT 20`).bind(ctx.account.id).all();
  return (rows.results ?? rows).map((row) => ({ id: row.id, app: row.name || 'Unnamed app',
    connectedAt: row.created_at, lastUsedAt: row.last_used_at, thisConnection: row.id === ctx.grantId }));
}

async function status(env, ctx) {
  const { devices } = await accountDevices(env, ctx.account.id);
  const computers = devices.filter((device) => !device.revoked_at).map((device) => {
    const minutes = minutesSince(device.last_seen_at);
    return { id: device.id, name: device.name, pairedAt: device.created_at, lastSeenAt: device.last_seen_at,
      online: minutes !== null && minutes < 3 };
  });
  const balance = await wallet(env, ctx.account.id);
  const next = !computers.length ? 'No computer is paired yet. Call pair and run its commands on the computer that should do the work.'
    : balance.topUpsEnabled && balance.balanceCents < 1 ? 'The balance is empty, so new emails wait. Call billing for a top-up link.'
      : `Email ${ctx.account.agent_email} from ${ctx.account.owner_email} to run a task.`;
  return { ownerEmail: ctx.account.owner_email, agentEmail: ctx.account.agent_email, computers,
    revokedComputers: devices.length - computers.length, balance,
    recentRuns: await recentRuns(env, ctx, { limit: 5 }), connectedApps: await connections(env, ctx), next };
}

function startFlags({ model, effort, speed }) {
  if (!/^[a-z0-9._-]{1,80}$/i.test(model ?? '')) return '--projects';
  return `--projects --model ${model}${EFFORTS.includes(effort) ? ` --effort ${effort}` : ''}${SPEEDS.includes(speed) ? ` --speed ${speed}` : ''}`;
}

// The same steps as the site's "Copy setup prompt" (site/dist/app.js).
function setupPrompt(agent, pairCommand, startCommand) {
  return `Set up TagMails on this computer so emails to my agent address run here with ${agent}.

1. If \`tagmails --version\` fails, install it:
   - with Homebrew: brew install swaymun/tagmails/tagmails
   - otherwise: curl -fsSL https://tagmails.com/install.sh | sh (needs Node.js 20+)
2. Check that ${agent} is installed and signed in on this computer.
3. Pair this computer. The code works once and expires in 10 minutes:
   ${pairCommand}
4. Start TagMails in the background:
   ${startCommand}
5. Replies can attach only 3.5 MB of files. If you have a connected app for storage (for example Google Drive or Dropbox), save where larger files should go:
   tagmails set --instructions "For files too large for email, upload them to my <that storage> and reply with the link."
   If you have none, skip this step and tell me.
6. Run \`tagmails status\` and show me the output.

Don't send any email or change project files while setting this up. If a step fails, show me the error instead of working around it.`;
}

async function pair(env, ctx, args) {
  const { agent, model: requestedModel, effort, speed } = args;
  if (agent !== undefined && !['codex', 'claude'].includes(agent)) throw new ToolError('agent must be "codex" or "claude".');
  if (requestedModel !== undefined && !/^[a-z0-9._-]{1,80}$/i.test(String(requestedModel))) throw new ToolError('model is not a valid model id.');
  if (effort !== undefined && !EFFORTS.includes(effort)) throw new ToolError(`effort must be one of ${EFFORTS.join(', ')}.`);
  if (speed !== undefined && !SPEEDS.includes(speed)) throw new ToolError(`speed must be one of ${SPEEDS.join(', ')}.`);
  if (requestedModel && agent && harnessOf(requestedModel) !== agent) throw new ToolError(`${requestedModel} is not a ${agent} model.`);
  let settings = { model: requestedModel, effort, speed };
  if (!requestedModel) {
    const saved = await accountPreferences(env, ctx.account).catch(() => ({}));
    settings = agent && harnessOf(saved.model) !== agent
      ? { model: DEFAULT_MODELS[agent], effort, speed }
      : { model: saved.model, effort: effort ?? saved.effort, speed: speed ?? saved.speed };
  }
  const harness = agent ?? harnessOf(settings.model);
  const { code, expiresInSeconds } = await createPairingCode(env, ctx.account.id);
  const relay = ctx.origin === HOSTED_RELAY ? '' : ` --relay ${ctx.origin}`;
  const pairCommand = `tagmails pair ${code}${relay}`;
  const startCommand = `tagmails start ${startFlags(settings)}`;
  const label = harness === 'claude' ? 'Claude Code' : 'Codex';
  return { pairingCode: code, expiresInSeconds, expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    agent: label,
    install: { homebrew: 'brew install swaymun/tagmails/tagmails', script: 'curl -fsSL https://tagmails.com/install.sh | sh' },
    commands: [pairCommand, startCommand, 'tagmails status'],
    setupPrompt: setupPrompt(label, pairCommand, startCommand),
    note: 'Run these on the Mac or Linux computer that should do the work (or paste setupPrompt into Codex or Claude Code there). The code works once, for 10 minutes. Call status afterwards to see the computer check in.' };
}

async function runs(env, ctx, args) {
  const limit = args.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new ToolError('limit must be a whole number from 1 to 50.');
  if (args.threadId !== undefined && !UUID.test(String(args.threadId))) throw new ToolError('threadId must be a thread id from runs or status.');
  return { runs: await recentRuns(env, ctx, { limit, threadId: args.threadId ?? null }) };
}

// The relay may not hold a readable result: none yet, deleted after 30 days,
// or sealed so only the computer can read it. None of those is an error.
async function storedResult(env, key) {
  if (!key) return { status: 'none', value: null };
  try {
    const object = await env.MAIL.get(key);
    if (!object) return { status: 'expired', value: null };
    const value = JSON.parse(new TextDecoder().decode(await object.arrayBuffer()));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { status: 'available', value } : { status: 'unreadable', value: null };
  } catch { return { status: 'unreadable', value: null }; }
}

const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : null;

async function run(env, ctx, args) {
  if (!UUID.test(String(args.runId ?? ''))) throw new ToolError('runId must be a run id from runs or status.');
  const row = await env.DB.prepare(`SELECT j.id, j.thread_id, j.state, j.attempts, j.created_at, j.result_key, j.model_json,
    j.workspace_json, t.subject, m.sender_email, o.state AS delivery_state, o.provider_email_id
    FROM jobs j JOIN threads t ON t.id = j.thread_id JOIN messages m ON m.id = j.message_id
    LEFT JOIN outbox o ON o.job_id = j.id
    WHERE j.id = ? AND t.account_id = ? LIMIT 1`).bind(args.runId, ctx.account.id).first();
  if (!row) throw new ToolError('No run with that id in your account.');
  const stored = await storedResult(env, row.result_key);
  const result = stored.value;
  let files = [];
  try {
    files = (await selectedRunArtifacts(env, ctx.account.id, row.id, result?.artifactIds))
      .map((file) => ({ name: file.name, size: file.byte_size, expiresAt: file.expires_at }));
  } catch { /* Files are optional in a receipt. */ }
  const recipients = row.provider_email_id ? await env.DB.prepare(`SELECT recipient_email, status FROM delivery_recipients
    WHERE job_id = ? AND provider_email_id = ? ORDER BY recipient_email`).bind(row.id, row.provider_email_id).all()
    : { results: [] };
  const answer = text(result?.answer, 20_000);
  return {
    id: row.id, threadId: row.thread_id, state: row.state, attempts: row.attempts, createdAt: row.created_at,
    subject: await readableText(env, row.subject), from: row.sender_email, project: projectName(row.workspace_json),
    model: selectedModelStatus(row.model_json),
    delivery: { state: row.delivery_state ?? null, recipients: (recipients.results ?? recipients)
      .map((item) => ({ email: item.recipient_email, status: item.status })) },
    result: { status: stored.status, outcome: text(result?.state, 40), summary: text(result?.summary, 4000),
      answer, answerTruncated: typeof result?.answer === 'string' && result.answer.length > 20_000,
      details: text(result?.details, 4000),
      checks: Array.isArray(result?.checks) ? result.checks.filter((check) => typeof check === 'string').slice(0, 20) : [] },
    files, receiptUrl: `${ctx.origin}/runs/${row.id}`,
  };
}

async function billing(env, ctx, _args, { stripeFetch }) {
  const balance = await wallet(env, ctx.account.id);
  if (!balance.topUpsEnabled) return { ...balance, checkoutUrl: null, message: 'Top-ups are not enabled on this relay.' };
  const site = configuredOrigin(env.SITE_ORIGIN);
  const checkout = await startCheckout(env, ctx.account, {
    successUrl: site ? `${site}/?topup=returned#billing` : `${ctx.origin}/account?topup=returned`,
    cancelUrl: site ? `${site}/?topup=canceled#billing` : `${ctx.origin}/account?topup=canceled`,
  }, stripeFetch);
  if (checkout.error) throw new ToolError(`${checkout.error}. Try again in a minute.`);
  return { ...balance, checkoutUrl: checkout.checkoutUrl, amount: dollars(TOP_UP_CENTS * 1000), testMode: checkout.testMode,
    message: 'Open checkoutUrl to pay on Stripe. The balance goes up once Stripe confirms the payment; this tool never charges anything itself.' };
}

async function revokeDevice(env, ctx, args) {
  if (!UUID.test(String(args.deviceId ?? ''))) throw new ToolError('deviceId must be a computer id from status.');
  const device = await env.DB.prepare('SELECT name FROM devices WHERE id = ? AND account_id = ? AND revoked_at IS NULL')
    .bind(args.deviceId, ctx.account.id).first();
  if (!device || !await revokeAccountDevice(env, ctx.account.id, args.deviceId)) {
    throw new ToolError('No paired computer with that id. Call status to list them.');
  }
  return { revoked: true, name: device.name,
    message: `${device.name} is disconnected; its queued and running jobs failed. Pair it again to reconnect.` };
}

async function disconnect(env, ctx, args) {
  const target = args.connectionId ?? ctx.grantId;
  if (!UUID.test(String(target))) throw new ToolError('connectionId must be an id from status.connectedApps.');
  if (target !== ctx.grantId && !ctx.scopes.has(MANAGE)) throw new ToolError('Disconnecting another app needs the manage permission.');
  const changed = await env.DB.prepare(`UPDATE mcp_grants SET revoked_at = CURRENT_TIMESTAMP
    WHERE id = ? AND account_id = ? AND revoked_at IS NULL`).bind(target, ctx.account.id).run();
  if (!(changed.meta?.changes ?? changed.changes)) throw new ToolError('No connected app with that id.');
  return { disconnected: true, thisConnection: target === ctx.grantId };
}

const NO_INPUT = { type: 'object', properties: {}, additionalProperties: false };
const READ_ONLY = { readOnlyHint: true, openWorldHint: false };
const TOOLS = [
  { name: 'status', title: 'TagMails status', scope: READ, handler: status, annotations: READ_ONLY, inputSchema: NO_INPUT,
    description: 'Start here. Shows the agent email address, paired computers with their last check-in, the balance and price per email, the 5 most recent runs and the apps connected to this account.' },
  { name: 'pair', title: 'Pair a computer', scope: MANAGE, handler: pair,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Create a one-time pairing code (valid 10 minutes) and return the exact commands, plus a setup prompt, that install TagMails on a Mac or Linux computer, pair it and start it. They must run on the computer that should do the work.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      agent: { type: 'string', enum: ['codex', 'claude'], description: 'Which coding agent runs the emails. Defaults to the account default.' },
      model: { type: 'string', description: 'Optional model id, e.g. gpt-6-sol or claude-sonnet-5-5.' },
      effort: { type: 'string', enum: EFFORTS, description: 'Optional default reasoning effort.' },
      speed: { type: 'string', enum: SPEEDS, description: 'Optional default speed tier.' } } } },
  { name: 'runs', title: 'Recent runs', scope: READ, handler: runs, annotations: READ_ONLY,
    description: 'List recent runs (one per email the agent handled), newest first, with state, subject, sender, project, model and delivery state.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many runs (default 10).' },
      threadId: { type: 'string', description: 'Only runs in this email thread.' } } } },
  { name: 'run', title: 'Run receipt', scope: READ, handler: run, annotations: READ_ONLY,
    description: "One run's receipt: state, project, model, delivery to each recipient, attached files, and the agent's summary and answer when the relay can still read them.",
    inputSchema: { type: 'object', additionalProperties: false, required: ['runId'], properties: {
      runId: { type: 'string', description: 'A run id from runs or status.' } } } },
  { name: 'billing', title: 'Balance and top-up link', scope: MANAGE, handler: billing,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, inputSchema: NO_INPUT,
    description: 'Show the balance and return a Stripe Checkout link that adds $10 when the owner pays. Nothing is charged by this tool.' },
  { name: 'revoke_device', title: 'Disconnect a computer', scope: MANAGE, handler: revokeDevice,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: 'Disconnect a paired computer so it can no longer take emails. Its queued and running jobs fail. Pair again to reconnect.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['deviceId'], properties: {
      deviceId: { type: 'string', description: 'A computer id from status.' } } } },
  { name: 'disconnect', title: 'Disconnect this app', scope: null, handler: disconnect,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: "Revoke this app's access to TagMails (or, with connectionId, another connected app's). Signing in again reconnects it.",
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      connectionId: { type: 'string', description: 'An id from status.connectedApps. Defaults to this connection.' } } } },
];

const allowed = (tool, scopes) => !tool.scope || scopes.has(tool.scope);

const INSTRUCTIONS = `TagMails hands each email sent to the user's agent address to Codex or Claude Code on the user's own Mac or Linux computer and replies in the same thread. Call status first. To set up a computer, call pair and run its commands on that computer (or show them to the user if you can't run commands there). billing only returns a Stripe link; never say a payment happened.`;

function rpc(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }
const reply = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...OPEN_CORS } });

async function callTool(env, ctx, params, options) {
  const tool = TOOLS.find((item) => item.name === params?.name);
  if (!tool) return { error: [-32602, `Unknown tool: ${String(params?.name).slice(0, 80)}`] };
  const args = params.arguments ?? {};
  const fail = (message) => ({ result: { content: [{ type: 'text', text: message }], isError: true } });
  if (!allowed(tool, ctx.scopes)) return fail(`This connection was not given ${tool.scope}. Reconnect TagMails and allow it.`);
  if (typeof args !== 'object' || Array.isArray(args) || args === null) return fail('Arguments must be an object.');
  const unknown = Object.keys(args).filter((key) => !(key in tool.inputSchema.properties));
  if (unknown.length) return fail(`Unknown argument: ${unknown[0].slice(0, 40)}.`);
  try {
    const data = await tool.handler(env, ctx, args, options);
    return { result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data } };
  } catch (error) {
    if (error instanceof ToolError) return fail(error.message);
    console.error(`MCP tool ${tool.name} failed:`, error instanceof Error ? error.message : 'Unknown error');
    return fail('TagMails could not finish this request. Try again in a minute.');
  }
}

async function readBody(request) {
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY) throw new Error('Request too large');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing body');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); throw new Error('Request too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
}

export async function handleMcpRequest(request, env, { stripeFetch = fetch } = {}) {
  const url = new URL(request.url);
  if (url.pathname !== '/mcp') return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: OPEN_CORS });
  if (!env.DB) throw new Error('Account database is not configured');
  const grant = await mcpGrantFor(request, env);
  if (!grant) {
    const presented = request.headers.has('authorization');
    // Only a bad credential counts toward the strict per-IP limit; the first,
    // tokenless request is how clients discover where to sign in.
    if (presented && await rateLimited(env, 'AUTH_RATE_LIMIT', request, 'auth')) return tooManyRequests(OPEN_CORS);
    const challenge = `Bearer resource_metadata="${resourceMetadataUrl(request)}", scope="${MCP_SCOPES.join(' ')}"${presented ? ', error="invalid_token"' : ''}`;
    return Response.json({ error: presented ? 'invalid_token' : 'Sign in required' }, { status: 401,
      headers: { 'Cache-Control': 'no-store', ...OPEN_CORS, 'WWW-Authenticate': challenge } });
  }
  if (await rateLimitedKey(env, 'PUBLIC_RATE_LIMIT', `mcp:${grant.account.id}`)) return tooManyRequests(OPEN_CORS);
  if (request.method !== 'POST') {
    // No server-initiated stream: every response comes back on its POST.
    return new Response(null, { status: 405, headers: { ...OPEN_CORS, Allow: 'POST, OPTIONS' } });
  }
  const version = request.headers.get('mcp-protocol-version');
  if (version && !PROTOCOL_VERSIONS.includes(version)) {
    return reply(rpcError(null, -32600, `Unsupported MCP-Protocol-Version: ${version.slice(0, 20)}`), 400);
  }
  let message;
  try { message = await readBody(request); }
  catch { return reply(rpcError(null, -32700, 'Parse error'), 400); }
  if (Array.isArray(message)) return reply(rpcError(null, -32600, 'Batch requests are not supported'), 400);
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
    return reply(rpcError(null, -32600, 'Invalid request'), 400);
  }
  const { id, method, params } = message;
  // Notifications and responses to us need no answer.
  if (typeof method !== 'string' || id === undefined) {
    return typeof method === 'string' || 'result' in message || 'error' in message
      ? new Response(null, { status: 202, headers: OPEN_CORS }) : reply(rpcError(id, -32600, 'Invalid request'), 400);
  }
  if (!['string', 'number'].includes(typeof id)) return reply(rpcError(null, -32600, 'Invalid request id'), 400);
  const ctx = { ...grant, origin: url.origin };
  if (method === 'initialize') {
    const requested = params?.protocolVersion;
    return reply(rpc(id, {
      protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'tagmails', title: 'TagMails', version: '1.0.0', websiteUrl: 'https://tagmails.com' },
      instructions: INSTRUCTIONS,
    }));
  }
  if (method === 'ping') return reply(rpc(id, {}));
  if (method === 'tools/list') {
    return reply(rpc(id, { tools: TOOLS.filter((tool) => allowed(tool, grant.scopes))
      .map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })) }));
  }
  if (method === 'tools/call') {
    const outcome = await callTool(env, ctx, params, { stripeFetch });
    return reply(outcome.error ? rpcError(id, ...outcome.error) : rpc(id, outcome.result));
  }
  return reply(rpcError(id, -32601, `Method not found: ${method.slice(0, 80)}`));
}
