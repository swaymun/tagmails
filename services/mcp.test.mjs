import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import relay from './relay-worker.mjs';
import { bindings } from './bindings-fixture.mjs';
import { handleAccountRequest } from './account-auth.mjs';
import { deleteExpiredMcpRows, handleOAuthRequest } from './mcp-oauth.mjs';
import { handleMcpRequest } from './mcp-server.mjs';

const ORIGIN = 'https://relay.test';
const REDIRECT = 'http://localhost:33418/callback';
const OWNER = { sub: 'google-sub-1', email: 'owner@gmail.com' };

function setup() {
  const fixture = bindings();
  Object.assign(fixture.env, { GOOGLE_CLIENT_ID: 'tagmails-test.apps.googleusercontent.com', AGENT_DOMAIN: 'tagmails.test' });
  return fixture;
}

const oauth = (env, path, init = {}, identity = OWNER) => handleOAuthRequest(new Request(`${ORIGIN}${path}`, init), env,
  { verifyIdentity: async (credential) => { if (credential !== 'google-ok') throw new Error('bad'); return identity; } });
const form = (params) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(params).toString() });

async function registerClient(env, redirectUris = [REDIRECT], name = 'Claude Code') {
  const response = await oauth(env, '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: name, redirect_uris: redirectUris, token_endpoint_auth_method: 'none' }) });
  return { response, body: await response.json() };
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function authorizeQuery(clientId, challenge, extra = {}) {
  return `?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT,
    code_challenge: challenge, code_challenge_method: 'S256', state: 'state-123', resource: `${ORIGIN}/mcp`, ...extra })}`;
}

async function approve(env, query, { identity = OWNER, origin = ORIGIN, credential = 'google-ok' } = {}) {
  return oauth(env, '/oauth/authorize', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential, query }) }, identity);
}

// Register, sign in with Google and trade the code: what Claude Code does on `claude mcp add`.
async function connect(env, { identity = OWNER, scope } = {}) {
  const client = (await registerClient(env)).body;
  const { verifier, challenge } = pkce();
  const approved = await (await approve(env, authorizeQuery(client.client_id, challenge, scope ? { scope } : {}), { identity })).json();
  const code = new URL(approved.redirect).searchParams.get('code');
  const tokens = await (await oauth(env, '/oauth/token', form({ grant_type: 'authorization_code', code,
    redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier }))).json();
  return { client, tokens };
}

let nextId = 1;
async function mcp(env, token, method, params, extra = {}) {
  const response = await handleMcpRequest(new Request(`${ORIGIN}/mcp`, { method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', ...extra.headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }) }), env, extra);
  return { response, body: response.status === 200 ? await response.json() : null };
}

async function tool(env, token, name, args = {}, extra = {}) {
  const { body } = await mcp(env, token, 'tools/call', { name, arguments: args }, extra);
  return body.result ? { ...body.result, data: body.result.structuredContent } : body;
}

function addRun(sqlite, { account = 'account-1', run, thread = '11111111-1111-4111-8111-111111111111', resultKey = null, subject = 'Fix the build' }) {
  sqlite.prepare('INSERT OR IGNORE INTO threads (id, account_id, subject) VALUES (?, ?, ?)').run(thread, account, subject);
  sqlite.prepare(`INSERT INTO messages (id, account_id, thread_id, message_id, direction, sender_email, object_key)
    VALUES (?, ?, ?, ?, 'inbound', ?, ?)`).run(`message-${run}`, account, thread, `<${run}@gmail.com>`, 'owner@gmail.com', `inbound/${run}.eml`);
  sqlite.prepare(`INSERT INTO jobs (id, thread_id, message_id, state, result_key, workspace_json)
    VALUES (?, ?, ?, 'completed', ?, ?)`).run(run, thread, `message-${run}`, resultKey, JSON.stringify({ name: 'wonder' }));
}

test('an MCP client discovers sign-in from a tokenless request and the published metadata', async () => {
  const { env } = setup();
  const { response } = await mcp(env, null, 'initialize', {});
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate'),
    /^Bearer resource_metadata="https:\/\/relay\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
  const resource = await (await relay.fetch(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`), env)).json();
  assert.deepEqual([resource.resource, resource.authorization_servers], [`${ORIGIN}/mcp`, [ORIGIN]]);
  const server = await (await relay.fetch(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`), env)).json();
  assert.equal(server.issuer, ORIGIN);
  assert.equal(server.registration_endpoint, `${ORIGIN}/oauth/register`);
  assert.deepEqual(server.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(server.token_endpoint_auth_methods_supported, ['none']);
});

test('Google sign-in authorizes a registered client with PKCE, and its token runs tools for that account only', async () => {
  const { env } = setup();
  const client = (await registerClient(env, [REDIRECT], '<b>Claude Code</b>')).body;
  assert.match(client.client_id, /^tm_cli_/);
  const { verifier, challenge } = pkce();
  const query = authorizeQuery(client.client_id, challenge);
  const consent = await relay.fetch(new Request(`${ORIGIN}/oauth/authorize${query}`), env);
  assert.equal(consent.status, 200);
  const html = await consent.text();
  assert.match(html, /Connect &lt;b&gt;Claude Code&lt;\/b&gt; to TagMails/, 'the client-chosen name is escaped');
  assert.match(html, /localhost:33418/, 'the page names where the user returns');
  assert.match(consent.headers.get('content-security-policy'), /frame-ancestors 'none'/);

  assert.equal((await approve(env, query, { origin: 'https://evil.test' })).status, 403, 'cross-site approval is refused');
  assert.equal((await approve(env, query, { credential: 'forged' })).status, 401);
  const redirect = new URL((await (await approve(env, query)).json()).redirect);
  assert.equal(`${redirect.origin}${redirect.pathname}`, REDIRECT);
  assert.equal(redirect.searchParams.get('state'), 'state-123');
  assert.equal(redirect.searchParams.get('iss'), ORIGIN);
  const code = redirect.searchParams.get('code');

  const exchange = (params) => oauth(env, '/oauth/token', form({ grant_type: 'authorization_code', code,
    redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier, ...params }));
  assert.equal((await exchange({ code_verifier: pkce().verifier })).status, 400, 'a wrong verifier burns the code');
  assert.equal((await exchange()).status, 400);

  const { tokens } = await connect(env);
  assert.match(tokens.access_token, /^tm_mcp_/);
  assert.equal(tokens.expires_in, 3600);
  assert.equal(tokens.scope, 'tagmails.read tagmails.manage');

  const init = await mcp(env, tokens.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  assert.equal(init.body.result.serverInfo.name, 'tagmails');
  const listed = await mcp(env, tokens.access_token, 'tools/list', {});
  assert.deepEqual(listed.body.result.tools.map((item) => item.name),
    ['status', 'pair', 'runs', 'run', 'billing', 'revoke_device', 'disconnect']);
  const status = await tool(env, tokens.access_token, 'status');
  assert.equal(status.data.agentEmail, 'agent@wonder.test');
  assert.equal(status.data.connectedApps.filter((app) => app.thisConnection).length, 1);
  assert.equal((await mcp(env, tokens.access_token, 'notifications/initialized')).response.status, 200,
    'a request with an id always gets an answer');
});

test('codes are single use, and replaying one revokes the tokens it produced', async () => {
  const { env } = setup();
  const client = (await registerClient(env)).body;
  const { verifier, challenge } = pkce();
  const code = new URL((await (await approve(env, authorizeQuery(client.client_id, challenge))).json()).redirect).searchParams.get('code');
  const exchange = () => oauth(env, '/oauth/token', form({ grant_type: 'authorization_code', code,
    redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier }));
  const tokens = await (await exchange()).json();
  assert.equal((await tool(env, tokens.access_token, 'status')).isError, undefined);
  assert.equal((await exchange()).status, 400);
  assert.equal((await mcp(env, tokens.access_token, 'tools/list')).response.status, 401);
});

test('the token endpoint binds tokens to /mcp, allows OAuth 2.1 requests without redirect_uri, and limits each client', async () => {
  const { env } = setup();
  const client = (await registerClient(env)).body;
  const codeFor = async (challenge) => new URL((await (await approve(env, authorizeQuery(client.client_id, challenge))).json()).redirect)
    .searchParams.get('code');
  const first = pkce();
  const elsewhere = await oauth(env, '/oauth/token', form({ grant_type: 'authorization_code', code: await codeFor(first.challenge),
    client_id: client.client_id, code_verifier: first.verifier, resource: 'https://unrelated.example/mcp' }));
  assert.equal((await elsewhere.json()).error, 'invalid_target');
  const second = pkce();
  const issued = await oauth(env, '/oauth/token', form({ grant_type: 'authorization_code', code: await codeFor(second.challenge),
    client_id: client.client_id, code_verifier: second.verifier, resource: `${ORIGIN}/mcp` }));
  assert.equal(issued.status, 200, 'redirect_uri may be omitted');
  const counts = new Map();
  env.AUTH_RATE_LIMIT = { async limit({ key }) { counts.set(key, (counts.get(key) ?? 0) + 1); return { success: counts.get(key) <= 1 }; } };
  const refresh = (token) => oauth(env, '/oauth/token', form({ grant_type: 'refresh_token', client_id: client.client_id,
    refresh_token: token }), OWNER);
  let current = (await issued.json()).refresh_token;
  for (let index = 0; index < 5; index += 1) await refresh(`tm_mcr_${'z'.repeat(43)}`);
  const rotated = await refresh(current);
  assert.equal(rotated.status, 200, 'bogus tokens do not spend the connection quota');
  current = (await rotated.json()).refresh_token;
  assert.equal((await refresh(current)).status, 429, 'refreshes are limited per connection');
});

test('the MCP endpoint refuses unexpected browser origins', async () => {
  const { env } = setup();
  const { tokens } = await connect(env);
  const call = (origin) => handleMcpRequest(new Request(`${ORIGIN}/mcp`, { method: 'POST', headers: {
    Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) }), env);
  assert.equal((await call('https://evil.example')).status, 403);
  for (const origin of [null, 'https://claude.ai', 'http://localhost:6274', ORIGIN]) assert.equal((await call(origin)).status, 200, origin);
});

test('registration and authorization accept only safe, registered return addresses', async () => {
  const { env, sqlite } = setup();
  for (const uri of ['javascript:alert(1)', 'http://example.com/callback', 'https://claude.ai/cb#frag', 'data:text/html,x']) {
    assert.equal((await registerClient(env, [uri])).response.status, 400, uri);
  }
  for (const uri of ['https://claude.ai/api/mcp/auth_callback', 'http://127.0.0.1:1234/cb', 'cursor://anysphere/oauth']) {
    assert.equal((await registerClient(env, [uri])).response.status, 201, uri);
  }
  const client = (await registerClient(env)).body;
  const { challenge } = pkce();
  const elsewhere = await relay.fetch(new Request(`${ORIGIN}/oauth/authorize${authorizeQuery(client.client_id, challenge,
    { redirect_uri: 'https://evil.test/cb' })}`), env);
  assert.equal(elsewhere.status, 400, 'an unregistered redirect is never followed');
  assert.equal(elsewhere.headers.get('location'), null);
  const otherPort = await approve(env, authorizeQuery(client.client_id, challenge, { redirect_uri: 'http://localhost:50000/callback' }));
  assert.match((await otherPort.json()).redirect, /^http:\/\/localhost:50000\/callback\?code=/, 'loopback may use any port');
  // Errors stay on TagMails' page: anyone can register a client, so redirecting them would be an open redirect.
  for (const [query, message] of [[authorizeQuery(client.client_id, 'short'), /PKCE/],
    [authorizeQuery(client.client_id, challenge, { response_type: 'token' }), /code flow/],
    [authorizeQuery(client.client_id, challenge, { scope: 'tagmails.reed' }), /permission TagMails doesn/]]) {
    const refused = await relay.fetch(new Request(`${ORIGIN}/oauth/authorize${query}`), env);
    assert.equal(refused.status, 400, query);
    assert.equal(refused.headers.get('location'), null);
    assert.match(await refused.text(), message);
  }
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM mcp_auth_codes').get().n, 1);
});

test('a private relay lets only its owner connect; an open relay creates the account on first sign-in', async () => {
  const { env, sqlite } = setup();
  delete env.PUBLIC_SIGNUP_ENABLED;
  env.PILOT_OWNER_EMAIL = 'owner@gmail.com';
  const client = (await registerClient(env)).body;
  const stranger = { sub: 'google-sub-9', email: 'stranger@gmail.com' };
  assert.equal((await approve(env, authorizeQuery(client.client_id, pkce().challenge), { identity: stranger })).status, 403);
  env.PUBLIC_SIGNUP_ENABLED = 'true';
  const { tokens } = await connect(env, { identity: stranger });
  const status = await tool(env, tokens.access_token, 'status');
  assert.equal(status.data.ownerEmail, 'stranger@gmail.com');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 2);
});

test('refresh tokens rotate, a stale reuse ends the grant, and revocation ends it at once', async () => {
  const { env, sqlite } = setup();
  const { client, tokens } = await connect(env);
  const refresh = (token, clientId = client.client_id) => oauth(env, '/oauth/token',
    form({ grant_type: 'refresh_token', refresh_token: token, client_id: clientId }));
  assert.equal((await refresh(tokens.refresh_token, 'tm_cli_AAAAAAAAAAAAAAAAAAAAAA')).status, 400, 'another client cannot refresh');
  const fresh = await connect(env);
  const one = await (await refresh(fresh.tokens.refresh_token, fresh.client.client_id)).json();
  assert.match(one.access_token, /^tm_mcp_/);
  const two = await (await refresh(one.refresh_token, fresh.client.client_id)).json();
  assert.match(two.refresh_token, /^tm_mcr_/, 'the rotated token refreshes again');
  // A spent token presented again, even seconds later, means two holders: whoever refreshed first may be a thief.
  assert.equal((await refresh(one.refresh_token, fresh.client.client_id)).status, 400);
  assert.equal((await mcp(env, two.access_token, 'tools/list')).response.status, 401, 'reuse revokes the grant');
  assert.equal((await refresh(two.refresh_token, fresh.client.client_id)).status, 400, 'the latest refresh token is dead too');

  const revoked = await connect(env);
  assert.equal((await oauth(env, '/oauth/revoke', form({ token: revoked.tokens.refresh_token }))).status, 200);
  assert.equal((await mcp(env, revoked.tokens.access_token, 'tools/list')).response.status, 401);
  sqlite.prepare("UPDATE mcp_tokens SET expires_at = datetime('now', '-1 minute') WHERE kind = 'access'").run();
  assert.equal((await mcp(env, tokens.access_token, 'tools/list')).response.status, 401, 'access tokens expire');
  await deleteExpiredMcpRows(env);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM mcp_tokens WHERE kind = 'access'").get().n, 0);
});

test('a read-only connection sees and runs only read tools', async () => {
  const { env } = setup();
  const { tokens } = await connect(env, { scope: 'tagmails.read' });
  assert.equal(tokens.scope, 'tagmails.read');
  const names = (await mcp(env, tokens.access_token, 'tools/list')).body.result.tools.map((item) => item.name);
  assert.deepEqual(names, ['status', 'runs', 'run', 'disconnect']);
  const refused = await mcp(env, tokens.access_token, 'tools/call', { name: 'pair', arguments: {} });
  assert.equal(refused.response.status, 403);
  assert.match(refused.response.headers.get('www-authenticate'),
    /^Bearer error="insufficient_scope", scope="tagmails\.read tagmails\.manage", resource_metadata=/);
});

test('pair returns a working one-time code and the commands for this relay', async () => {
  const { env } = setup();
  const { tokens } = await connect(env);
  const paired = (await tool(env, tokens.access_token, 'pair', { agent: 'claude' })).data;
  assert.match(paired.pairingCode, /^tm_pair_[A-Za-z0-9_-]{27}$/);
  assert.equal(paired.commands[0], `tagmails pair ${paired.pairingCode} --relay ${ORIGIN}`, 'a non-hosted relay is named');
  assert.equal(paired.commands[1], 'tagmails start --projects --model claude-sonnet-5-5');
  assert.match(paired.setupPrompt, /with Claude Code\./);
  assert.ok(paired.setupPrompt.includes(paired.commands[0]));
  assert.equal((await tool(env, tokens.access_token, 'pair', { agent: 'codex', model: 'claude-sonnet-5-5' })).isError, true);
  const device = await handleAccountRequest(new Request(`${ORIGIN}/api/device/pair`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: paired.pairingCode, token: `tm_dev_${'a'.repeat(43)}`, name: 'Studio Mac' }) }), env);
  assert.equal(device.status, 201);
  const status = (await tool(env, tokens.access_token, 'status')).data;
  assert.deepEqual(status.computers.map((computer) => computer.name), ['Studio Mac']);
  env.PUBLIC_ORIGIN = 'https://tagmails-relay-dev.saimun-shahee.workers.dev';
  const hosted = (await tool(env, tokens.access_token, 'pair')).data;
  assert.equal(hosted.commands[0], `tagmails pair ${hosted.pairingCode}`,
    'reached through tagmails.com, the hosted relay still pairs without --relay');
  // Removing the app voids a code it made that wasn't used yet.
  assert.equal((await oauth(env, '/oauth/revoke', form({ token: tokens.access_token }))).status, 200);
  const late = await handleAccountRequest(new Request(`${ORIGIN}/api/device/pair`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: hosted.pairingCode, token: `tm_dev_${'b'.repeat(43)}`, name: 'Other Mac' }) }), env);
  assert.equal(late.status, 409);
});

test('runs and run cover only this account and tolerate a missing or unreadable result', async () => {
  const { env, sqlite } = setup();
  sqlite.prepare('INSERT INTO accounts (id, google_sub, owner_email, agent_email) VALUES (?, ?, ?, ?)')
    .run('account-2', 'google-sub-2', 'other@gmail.com', 'other@wonder.test');
  const run = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  addRun(sqlite, { run: run(1), resultKey: 'results/one.json' });
  addRun(sqlite, { run: run(2), resultKey: 'results/gone.json' });
  addRun(sqlite, { run: run(3), resultKey: 'results/sealed.json' });
  addRun(sqlite, { account: 'account-2', run: run(4), thread: '22222222-2222-4222-8222-222222222222', subject: 'Private' });
  addRun(sqlite, { run: run(5), resultKey: 'results/device.json' });
  sqlite.prepare('UPDATE jobs SET result_meta_json = ? WHERE id = ?').run(JSON.stringify({ state: 'completed', runtime: 'codex-app-server-write' }), run(5));
  await env.MAIL.put('results/one.json', JSON.stringify({ state: 'completed', summary: 'Build fixed.', answer: 'Done.', checks: ['npm test'] }));
  await env.MAIL.put('results/sealed.json', 'tmenc:not-json-for-the-relay');
  const { generateDeviceKey, sealForDevice } = await import('../agent/device-seal.mjs');
  await env.MAIL.put('results/device.json', await sealForDevice((await generateDeviceKey()).publicKey, JSON.stringify({ answer: 'secret' }), 'result'));
  const { tokens } = await connect(env);
  const listed = (await tool(env, tokens.access_token, 'runs', { limit: 10 })).data.runs;
  assert.deepEqual(listed.map((item) => item.id).sort(), [run(1), run(2), run(3), run(5)]);
  assert.equal(listed[0].project, 'wonder');
  const one = (await tool(env, tokens.access_token, 'run', { runId: run(1) })).data;
  assert.deepEqual([one.result.status, one.result.summary, one.result.answer], ['available', 'Build fixed.', 'Done.']);
  assert.equal(one.receiptUrl, `${ORIGIN}/runs/${run(1)}`);
  env.SITE_ORIGIN = 'https://tagmails.com';
  assert.equal((await tool(env, tokens.access_token, 'run', { runId: run(1) })).data.receiptUrl,
    `https://tagmails.com/?run=${run(1)}#emails`, 'the owner opens runs on the Site, like email footers');
  assert.equal((await tool(env, tokens.access_token, 'run', { runId: run(2) })).data.result.status, 'expired');
  const sealed = (await tool(env, tokens.access_token, 'run', { runId: run(3) })).data;
  assert.deepEqual([sealed.result.status, sealed.result.summary, sealed.subject], ['unreadable', null, 'Fix the build']);
  // Sealed to the owner's computer: status and outcome only.
  const device = (await tool(env, tokens.access_token, 'run', { runId: run(5) })).data;
  assert.deepEqual([device.result.status, device.result.outcome, device.result.answer], ['sealed', 'completed', null]);
  const foreign = await tool(env, tokens.access_token, 'run', { runId: run(4) });
  assert.equal(foreign.isError, true, "another account's run is not found");
  assert.equal((await tool(env, tokens.access_token, 'runs', { limit: 500 })).isError, true);
});

test('billing returns a Stripe link without moving money, and only when top-ups are on', async () => {
  const { env, sqlite } = setup();
  const { tokens } = await connect(env);
  const off = (await tool(env, tokens.access_token, 'billing')).data;
  assert.deepEqual([off.checkoutUrl, off.pricePerEmail], [null, '$0.05']);
  Object.assign(env, { BILLING_TEST_MODE: 'true', STRIPE_SECRET_KEY: 'sk_test_local', STRIPE_WEBHOOK_SECRET: 'whsec_local',
    SITE_ORIGIN: 'https://tagmails.com' });
  let sent;
  const stripeFetch = async (url, options) => {
    sent = new URLSearchParams(options.body);
    return Response.json({ id: 'cs_test_mcp', url: 'https://checkout.stripe.com/c/pay/cs_test_mcp' });
  };
  const on = (await tool(env, tokens.access_token, 'billing', {}, { stripeFetch })).data;
  assert.equal(on.checkoutUrl, 'https://checkout.stripe.com/c/pay/cs_test_mcp');
  assert.equal(sent.get('customer_email'), 'owner@gmail.com');
  assert.equal(sent.get('success_url'), 'https://tagmails.com/?topup=returned#billing');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM credit_ledger').get().n, 0, 'nothing is credited before payment');
  assert.equal(sqlite.prepare("SELECT stripe_session_id FROM billing_checkouts WHERE account_id = 'account-1'").get().stripe_session_id, 'cs_test_mcp');
});

test("revoke_device disconnects only this account's computer, and disconnect ends this connection", async () => {
  const { env, sqlite } = setup();
  sqlite.prepare('INSERT INTO accounts (id, google_sub, owner_email, agent_email) VALUES (?, ?, ?, ?)')
    .run('account-2', 'google-sub-2', 'other@gmail.com', 'other@wonder.test');
  const mine = '33333333-3333-4333-8333-333333333333';
  const theirs = '44444444-4444-4444-8444-444444444444';
  sqlite.prepare("INSERT INTO devices (id, account_id, token_hash, name) VALUES (?, 'account-1', 'h1', 'Mine')").run(mine);
  sqlite.prepare("INSERT INTO devices (id, account_id, token_hash, name) VALUES (?, 'account-2', 'h2', 'Theirs')").run(theirs);
  const { tokens } = await connect(env);
  assert.equal((await tool(env, tokens.access_token, 'revoke_device', { deviceId: theirs })).isError, true);
  assert.equal(sqlite.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(theirs).revoked_at, null);
  assert.equal((await tool(env, tokens.access_token, 'revoke_device', { deviceId: mine })).data.revoked, true);
  assert.notEqual(sqlite.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(mine).revoked_at, null);
  const other = await connect(env, { identity: { sub: 'google-sub-2', email: 'other@gmail.com' } });
  const otherGrant = (await tool(env, other.tokens.access_token, 'status')).data.connectedApps[0].id;
  assert.equal((await tool(env, tokens.access_token, 'disconnect', { connectionId: otherGrant })).isError, true,
    "another account's connection can't be revoked");
  assert.equal((await tool(env, tokens.access_token, 'disconnect')).data.disconnected, true);
  assert.equal((await mcp(env, tokens.access_token, 'tools/list')).response.status, 401);
  assert.equal((await mcp(env, other.tokens.access_token, 'tools/list')).response.status, 200);
});

test('bad MCP tokens share the strict per-IP limit; tokenless discovery and good tokens do not', async () => {
  const { env } = setup();
  const counts = new Map();
  const limiter = (limit) => ({ async limit({ key }) { counts.set(key, (counts.get(key) ?? 0) + 1); return { success: counts.get(key) <= limit }; } });
  const { tokens } = await connect(env);
  env.AUTH_RATE_LIMIT = limiter(2);
  env.PUBLIC_RATE_LIMIT = limiter(1000);
  const call = (token) => handleMcpRequest(new Request(`${ORIGIN}/mcp`, { method: 'POST', headers: {
    'cf-connecting-ip': '5.5.5.5', 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) }), env);
  for (let index = 0; index < 5; index += 1) assert.equal((await call(null)).status, 401);
  for (let index = 0; index < 5; index += 1) assert.equal((await call(tokens.access_token)).status, 200);
  const bad = `tm_mcp_${'x'.repeat(43)}`;
  assert.equal((await call(bad)).status, 401);
  assert.equal((await call(bad)).status, 401);
  assert.equal((await call(bad)).status, 429);
  assert.equal(counts.get(`mcp:account-1`), 5, 'signed-in calls are counted per account');
});
