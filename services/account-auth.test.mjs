import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { bindings } from './bindings-fixture.mjs';
import { handleAccountRequest, verifyGoogleCredential } from './account-auth.mjs';
import { handleDeviceRequest } from './device-jobs.mjs';
import { handleInbound } from './relay-worker.mjs';

const clientId = 'tagmails-test.apps.googleusercontent.com';

async function signedGoogleToken(overrides = {}) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const key = { ...(await exportJWK(publicKey)), kid: 'test-key', use: 'sig' };
  const claims = { sub: 'google-user-2', email: 'new.owner@gmail.com', email_verified: true, ...overrides };
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer('https://accounts.google.com')
    .setAudience(clientId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  return { token, keys: createLocalJWKSet({ keys: [key] }) };
}

function request(path, method = 'GET', body, cookie, origin = 'https://relay.test') {
  return new Request(`https://relay.test${path}`, {
    method,
    headers: {
      ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test('Google ID tokens require a valid signature, client, and verified personal Gmail address', async () => {
  const { token, keys } = await signedGoogleToken();
  assert.deepEqual(await verifyGoogleCredential(token, clientId, keys), {
    sub: 'google-user-2', email: 'new.owner@gmail.com',
  });
  await assert.rejects(verifyGoogleCredential(token, 'another-client', keys));
  await assert.rejects(verifyGoogleCredential(`${token}x`, clientId, keys));
  for (const claims of [{ email_verified: false }, { email: 'owner@example.com' }, { azp: 'another-client' }]) {
    const invalid = await signedGoogleToken(claims);
    await assert.rejects(verifyGoogleCredential(invalid.token, clientId, invalid.keys));
  }
});

test('a Gmail owner signs in, pairs one device, revokes it, and signs out', async () => {
  const { env, sqlite } = bindings();
  env.GOOGLE_CLIENT_ID = clientId;
  env.AGENT_DOMAIN = 'tagmails.test';
  env.SITE_ORIGIN = 'https://tagmails.chatgpt.site';
  const identity = { sub: 'google-user-2', email: 'new.owner@gmail.com' };
  const options = { verifyIdentity: async (credential) => {
    if (credential !== 'test') throw new Error('Invalid credential');
    return identity;
  } };
  assert.equal((await handleAccountRequest(request('/api/account/me'), env, options)).status, 401);
  assert.equal((await handleAccountRequest(request('/api/auth/google', 'POST', { credential: 'test' }, null, 'https://attacker.test'), env, options)).status, 403);
  const signedIn = await handleAccountRequest(request('/api/auth/google', 'POST', { credential: 'test' }), env, options);
  assert.equal(signedIn.status, 200);
  const profile = await signedIn.json();
  assert.equal(profile.ownerEmail, identity.email);
  assert.match(profile.agentEmail, /^u-[a-f0-9]{20}@tagmails\.test$/);
  const cookie = signedIn.headers.get('set-cookie').split(';')[0];
  assert.match(signedIn.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
  const account = await handleAccountRequest(request('/api/account/me', 'GET', undefined, cookie), env, options);
  assert.deepEqual(await account.json(), { ownerEmail: identity.email, agentEmail: profile.agentEmail,
    defaultModel: 'gpt-6.1-sol', deliveryReady: false });
  const second = await handleAccountRequest(request('/api/auth/google', 'POST', { credential: 'test' }), env, options);
  assert.equal((await second.json()).agentEmail, profile.agentEmail);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM accounts WHERE google_sub = ?').get(identity.sub).n, 1);
  const siteSignIn = await handleAccountRequest(new Request('https://relay.test/api/auth/google', {
    method: 'POST', headers: { Origin: env.SITE_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential: 'test' }),
  }), env, options);
  assert.equal(siteSignIn.status, 200);
  assert.equal(siteSignIn.headers.get('access-control-allow-origin'), env.SITE_ORIGIN);
  assert.equal(siteSignIn.headers.get('set-cookie'), null);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM accounts WHERE google_sub = ?').get(identity.sub).n, 1);
  assert.equal((await handleAccountRequest(new Request('https://relay.test/api/auth/google', {
    method: 'OPTIONS', headers: { Origin: env.SITE_ORIGIN },
  }), env, options)).status, 204);
  assert.equal((await handleAccountRequest(request('/api/account/default-model', 'POST',
    { model: 'claude-sonnet-5-5' }, cookie), env, options)).status, 200);
  assert.equal((await handleAccountRequest(request('/api/account/default-model', 'POST',
    { model: 'gpt-6-luna' }, cookie), env, options)).status, 400);
  assert.equal((await handleAccountRequest(request('/api/account/default-model', 'POST',
    { model: 'gpt-6.1-sol' }, cookie, 'https://attacker.test'), env, options)).status, 403);
  const siteDefault = await handleAccountRequest(new Request('https://relay.test/api/site/default-model', {
    method: 'POST', headers: { Origin: env.SITE_ORIGIN, Authorization: 'Bearer test',
      'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-6.1-sol' }),
  }), env, options);
  assert.equal(siteDefault.status, 200);
  assert.equal(siteDefault.headers.get('access-control-allow-origin'), env.SITE_ORIGIN);
  assert.deepEqual(await siteDefault.json(), { defaultModel: 'gpt-6.1-sol' });
  const siteAccount = await handleAccountRequest(new Request('https://relay.test/api/site/account', {
    headers: { Origin: env.SITE_ORIGIN, Authorization: 'Bearer test' },
  }), env, options);
  assert.equal((await siteAccount.json()).defaultModel, 'gpt-6.1-sol');

  const codeResponse = await handleAccountRequest(request('/api/account/pairing-code', 'POST', {}, cookie), env, options);
  const { code } = await codeResponse.json();
  assert.match(code, /^tm_pair_[A-Za-z0-9_-]{27}$/);
  const token = `tm_dev_${randomBytes(32).toString('base64url')}`;
  const pairRequest = new Request('https://relay.test/api/device/pair', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, token, name: 'Saimun Mac' }),
  });
  const paired = await handleAccountRequest(pairRequest, env, options);
  assert.equal(paired.status, 201);
  const { deviceId } = await paired.json();
  assert.equal(sqlite.prepare('SELECT name FROM devices WHERE id = ?').get(deviceId).name, 'Saimun Mac');
  const listed = await handleAccountRequest(request('/api/account/devices', 'GET', undefined, cookie), env, options);
  assert.equal((await listed.json()).devices[0].id, deviceId);
  assert.equal((await handleAccountRequest(new Request('https://relay.test/api/device/pair', {
    method: 'POST', body: JSON.stringify({ code, token: `tm_dev_${randomBytes(32).toString('base64url')}`, name: 'Other' }),
  }), env, options)).status, 409);
  const claim = await handleDeviceRequest(new Request('https://relay.test/api/device/claim', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  }), env);
  assert.deepEqual(await claim.json(), { claimed: false });

  const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const accountId = sqlite.prepare('SELECT id FROM accounts WHERE google_sub = ?').get(identity.sub).id;
  sqlite.prepare('INSERT INTO threads (id, account_id, subject) VALUES (?, ?, ?)')
    .run('receipt-thread', accountId, 'Private <review>');
  sqlite.prepare(`INSERT INTO messages (id, account_id, thread_id, message_id, direction, sender_email, object_key)
    VALUES (?, ?, ?, ?, 'inbound', ?, ?)`).run('receipt-message', accountId, 'receipt-thread',
    '<receipt@gmail.com>', identity.email, 'inbound/receipt.eml');
  sqlite.prepare(`INSERT INTO jobs (id, thread_id, message_id, state, result_key, model_json)
    VALUES (?, ?, ?, 'completed', ?, ?)`).run(runId, 'receipt-thread', 'receipt-message', 'results/receipt.json',
      JSON.stringify({ id: 'claude-sonnet-5-5', effort: 'medium', source: 'explicit' }));
  const artifactId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  sqlite.prepare(`INSERT INTO run_artifacts
    (id, account_id, job_id, lease_id, object_key, name, mime_type, byte_size)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(artifactId, accountId, runId,
    'receipt-lease', 'artifacts/receipt.bin', 'review <draft>.txt', 'text/plain', 4);
  await env.MAIL.put('artifacts/receipt.bin', 'memo');
  await env.MAIL.put('results/receipt.json', JSON.stringify({ state: 'completed', summary: 'Checked <safely>',
    details: ['Found one item.'], checks: ['No external action.'], artifactIds: [artifactId],
    transcript: { version: 1, truncated: false, events: [
      { kind: 'request', text: 'Find <private> items' }, { kind: 'tool', text: 'Read completed.' },
      { kind: 'assistant', text: 'Found one item.' }] },
    usage: { inputTokens: 302, cachedInputTokens: 100, cacheCreationInputTokens: 200,
      outputTokens: 30, reasoningOutputTokens: 4 }, reportedListCostUsd: 0.010528 }));
  const receipt = await handleAccountRequest(request(`/runs/${runId}`, 'GET', undefined, cookie), env, options);
  assert.equal(receipt.status, 200);
  const html = await receipt.text();
  assert.match(html, /Checked &lt;safely&gt;/);
  assert.doesNotMatch(html, /<safely>/);
  assert.match(html, /Private &lt;review&gt;/);
  assert.match(html, /Find &lt;private&gt; items/);
  assert.match(html, /Selected model: Claude Code Sonnet 5\.5 \(medium; requested in this email\)/);
  assert.doesNotMatch(html, /<private>/);
  assert.match(html, /302 input tokens/);
  assert.match(html, /\$0\.010528/);
  assert.match(html, /not a TagMails charge/);
  assert.match(html, /review &lt;draft&gt;\.txt/);
  assert.doesNotMatch(html, /review <draft>\.txt/);
  assert.equal(receipt.headers.get('cache-control'), 'no-store');
  const siteRequest = (credential = 'test', origin = env.SITE_ORIGIN) => new Request(`https://relay.test/api/runs/${runId}`, {
    headers: { Authorization: `Bearer ${credential}`, Origin: origin },
  });
  assert.equal((await handleAccountRequest(siteRequest('bad'), env, options)).status, 401);
  const siteRun = await handleAccountRequest(siteRequest(), env, options);
  assert.equal(siteRun.headers.get('access-control-allow-origin'), env.SITE_ORIGIN);
  assert.equal(siteRun.headers.get('cache-control'), 'no-store');
  const siteResult = await siteRun.json();
  assert.equal(siteResult.selectedModel, 'Selected model: Claude Code Sonnet 5.5 (medium; requested in this email).');
  assert.equal(siteResult.result.transcript.events[0].text, 'Find <private> items');
  assert.equal(siteResult.artifacts[0].name, 'review <draft>.txt');
  const receiptFile = await handleAccountRequest(request(`/runs/${runId}/artifacts/${artifactId}`, 'GET', undefined, cookie), env, options);
  assert.equal(await receiptFile.text(), 'memo');
  assert.equal(receiptFile.headers.get('content-type'), 'application/octet-stream');
  assert.equal((await handleAccountRequest(siteRequest('test', 'https://attacker.test'), env, options))
    .headers.get('access-control-allow-origin'), null);
  const preflight = await handleAccountRequest(new Request(`https://relay.test/api/runs/${runId}`, {
    method: 'OPTIONS', headers: { Origin: env.SITE_ORIGIN, 'Access-Control-Request-Method': 'GET' },
  }), env, options);
  assert.equal(preflight.status, 204);
  const redirect = await handleAccountRequest(request(`/runs/${runId}`), env, options);
  assert.equal(redirect.status, 302);
  assert.match(redirect.headers.get('location'), /\/account\?next=/);
  const other = await handleAccountRequest(request('/api/auth/google', 'POST', { credential: 'test' }), env, {
    verifyIdentity: async () => ({ sub: 'google-sub-1', email: 'owner@gmail.com' }),
  });
  const otherCookie = other.headers.get('set-cookie').split(';')[0];
  assert.equal((await handleAccountRequest(request(`/runs/${runId}`, 'GET', undefined, otherCookie), env, options)).status, 404);
  assert.equal((await handleAccountRequest(request(`/runs/${runId}/artifacts/${artifactId}`, 'GET', undefined, otherCookie), env, options)).status, 404);
  assert.equal((await handleAccountRequest(siteRequest(), env, {
    verifyIdentity: async () => ({ sub: 'google-sub-1', email: 'owner@gmail.com' }),
  })).status, 404);

  assert.equal((await handleAccountRequest(request(`/api/account/devices/${deviceId}/revoke`, 'POST', {}, cookie), env, options)).status, 200);
  assert.equal((await handleDeviceRequest(new Request('https://relay.test/api/device/claim', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  }), env)).status, 401);
  assert.equal((await handleAccountRequest(request('/api/auth/logout', 'POST', {}, cookie), env, options)).status, 200);
  assert.equal((await handleAccountRequest(request('/api/account/me', 'GET', undefined, cookie), env, options)).status, 401);
});

test('the private Site can show the owner account and manage only its paired devices', async () => {
  const { env, sqlite } = bindings();
  env.GOOGLE_CLIENT_ID = clientId;
  env.SITE_ORIGIN = 'https://tagmails.chatgpt.site';
  const options = { verifyIdentity: async (credential) => {
    if (credential !== 'owner-token') throw new Error('Invalid credential');
    return { sub: 'google-sub-1', email: 'owner@gmail.com' };
  } };
  const site = (path, method = 'GET', credential = 'owner-token', origin = env.SITE_ORIGIN) =>
    new Request(`https://relay.test${path}`, { method,
      headers: { Origin: origin, Authorization: `Bearer ${credential}` } });
  assert.equal((await handleAccountRequest(site('/api/site/account', 'OPTIONS'), env, options)).status, 204);
  assert.equal((await handleAccountRequest(site('/api/site/account', 'GET', 'bad-token'), env, options)).status, 401);
  const wrongOrigin = await handleAccountRequest(site('/api/site/account', 'GET', 'owner-token', 'https://attacker.test'), env, options);
  assert.equal(wrongOrigin.status, 403);
  assert.equal(wrongOrigin.headers.get('access-control-allow-origin'), null);
  const account = await handleAccountRequest(site('/api/site/account'), env, options);
  assert.equal(account.headers.get('access-control-allow-origin'), env.SITE_ORIGIN);
  assert.deepEqual(await account.json(), { ownerEmail: 'owner@gmail.com',
    agentEmail: 'agent@wonder.test', defaultModel: 'gpt-6.1-sol', deliveryReady: false });
  assert.equal((await handleAccountRequest(site('/api/site/devices'), env, options)).status, 200);
  const code = await (await handleAccountRequest(site('/api/site/pairing-code', 'POST'), env, options)).json();
  assert.match(code.code, /^tm_pair_[A-Za-z0-9_-]{27}$/);
  const token = `tm_dev_${randomBytes(32).toString('base64url')}`;
  const paired = await handleAccountRequest(new Request('https://relay.test/api/device/pair', {
    method: 'POST', body: JSON.stringify({ code: code.code, token, name: 'Site Mac' }),
  }), env, options);
  assert.equal(paired.status, 201);
  const { deviceId } = await paired.json();
  const listed = await (await handleAccountRequest(site('/api/site/devices'), env, options)).json();
  assert.equal(listed.devices[0].id, deviceId);
  assert.equal(sqlite.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(deviceId).revoked_at, null);
  assert.equal((await handleAccountRequest(site(`/api/site/devices/${deviceId}/revoke`, 'POST'), env, {
    verifyIdentity: async () => ({ sub: 'another-sub', email: 'other@gmail.com' }),
  })).status, 404);
  assert.equal((await handleAccountRequest(site(`/api/site/devices/${deviceId}/revoke`, 'POST'), env, options)).status, 200);
  assert.equal((await handleDeviceRequest(new Request('https://relay.test/api/device/claim', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  }), env)).status, 401);
});

test('the private Site lets only the Gmail owner manage reply access on an existing thread', async () => {
  const { env, sqlite } = bindings();
  env.GOOGLE_CLIENT_ID = clientId;
  env.SITE_ORIGIN = 'https://tagmails.chatgpt.site';
  const threadId = '11111111-1111-4111-8111-111111111111';
  sqlite.prepare('INSERT INTO threads (id, account_id, subject) VALUES (?, ?, ?)')
    .run(threadId, 'account-1', 'Shared <review>');
  const site = (path, method = 'GET', body, origin = env.SITE_ORIGIN, credential = 'owner-token') =>
    new Request(`https://relay.test${path}`, { method,
      headers: { Origin: origin, Authorization: `Bearer ${credential}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
  const owner = { verifyIdentity: async (credential) => {
    if (credential !== 'owner-token') throw new Error('Invalid credential');
    return { sub: 'google-sub-1', email: 'owner@gmail.com' };
  } };
  const route = (req, options = owner) => handleAccountRequest(req, env, options);
  assert.equal((await route(site('/api/site/threads', 'OPTIONS'))).status, 204);
  assert.equal((await route(site('/api/site/threads', 'GET', null, 'https://other.test'))).status, 403);
  assert.equal((await route(site('/api/site/threads', 'GET', null, env.SITE_ORIGIN, 'bad'))).status, 401);
  const listed = await route(site('/api/site/threads'));
  assert.equal(listed.headers.get('access-control-allow-origin'), env.SITE_ORIGIN);
  assert.deepEqual((await listed.json()).threads, [{ id: threadId, subject: 'Shared <review>',
    createdAt: sqlite.prepare('SELECT created_at FROM threads WHERE id = ?').get(threadId).created_at,
    latestRunId: null, participants: [] }]);
  const invitePath = `/api/site/threads/${threadId}/invite`;
  assert.equal((await route(site(invitePath, 'POST', { email: 'guest@gmail.com' }), {
    verifyIdentity: async () => ({ sub: 'another-sub', email: 'other@gmail.com' }),
  })).status, 404);
  assert.equal((await route(site(invitePath, 'POST', { email: 'bad address' }))).status, 400);
  const invited = await route(site(invitePath, 'POST', { email: 'Guest@gmail.com' }));
  assert.equal(invited.headers.get('access-control-allow-origin'), env.SITE_ORIGIN);
  assert.deepEqual(await invited.json(), { invited: true });
  assert.deepEqual((await (await route(site('/api/site/threads'))).json()).threads[0].participants,
    [{ email: 'guest@gmail.com', revokedAt: null }]);
  assert.equal((await route(site(`/api/site/threads/${threadId}/revoke`, 'POST',
    { email: 'guest@gmail.com' }, 'https://other.test'))).status, 403);
  const revoked = await route(site(`/api/site/threads/${threadId}/revoke`, 'POST',
    { email: 'guest@gmail.com' }));
  assert.deepEqual(await revoked.json(), { revoked: true });
  assert.ok(sqlite.prepare('SELECT revoked_at FROM participants WHERE thread_id = ? AND email = ?')
    .get(threadId, 'guest@gmail.com').revoked_at);
});

test('only the signed-in owner grants and revokes a hidden participant on an existing thread', async () => {
  const { env, sqlite } = bindings();
  env.GOOGLE_CLIENT_ID = clientId;
  env.AGENT_DOMAIN = 'tagmails.test';
  const owner = { verifyIdentity: async () => ({ sub: 'google-sub-1', email: 'owner@gmail.com' }) };
  const signedIn = await handleAccountRequest(request('/api/auth/google', 'POST', { credential: 'test' }), env, owner);
  const cookie = signedIn.headers.get('set-cookie').split(';')[0];
  const deliver = async (id, from, parentIds = [], bcc = []) => {
    const message = { providerEmailId: id, messageId: `<${id}@gmail.com>`, from,
      agentAddress: 'agent@wonder.test', to: ['agent@wonder.test'], cc: [], bcc,
      parentIds, subject: 'Hidden review', body: 'Review this.', attachments: [],
      rawMime: Buffer.from(`From: ${from}\r\nMessage-ID: <${id}@gmail.com>\r\n`) };
    const response = await handleInbound(request('/webhooks/resend', 'POST', {}), env, { inspect: async () => message });
    return response.json();
  };
  assert.deepEqual(await deliver('owner-first', 'owner@gmail.com', [], ['hidden@gmail.com']), { accepted: true, duplicate: false });
  const threadId = sqlite.prepare('SELECT id FROM threads').get().id;
  assert.deepEqual(await deliver('hidden-before', 'hidden@gmail.com', ['<owner-first@gmail.com>']), { accepted: false });
  const path = `/api/account/threads/${threadId}`;
  assert.equal((await handleAccountRequest(request(`${path}/invite`, 'POST', { email: 'hidden@gmail.com' }, cookie, 'https://elsewhere.test'), env, owner)).status, 403);
  assert.equal((await handleAccountRequest(request(`${path}/invite`, 'POST', { email: 'bad address' }, cookie), env, owner)).status, 400);
  assert.deepEqual(await (await handleAccountRequest(request(`${path}/invite`, 'POST', { email: 'HIDDEN@gmail.com' }, cookie), env, owner)).json(), { invited: true });
  const listed = await handleAccountRequest(request('/api/account/threads', 'GET', undefined, cookie), env, owner);
  assert.deepEqual((await listed.json()).threads[0].participants, [{ email: 'hidden@gmail.com', revokedAt: null }]);
  assert.deepEqual(await deliver('hidden-after', 'hidden@gmail.com', ['<owner-first@gmail.com>']), { accepted: true, duplicate: false });
  const other = await handleAccountRequest(request('/api/auth/google', 'POST', { credential: 'test' }), env, {
    verifyIdentity: async () => ({ sub: 'another-sub', email: 'another@gmail.com' }),
  });
  const otherCookie = other.headers.get('set-cookie').split(';')[0];
  assert.equal((await handleAccountRequest(request(`${path}/invite`, 'POST', { email: 'stranger@gmail.com' }, otherCookie), env, owner)).status, 404);
  assert.deepEqual((await (await handleAccountRequest(request('/api/account/threads', 'GET', undefined, otherCookie), env, owner)).json()).threads, []);
  assert.deepEqual(await (await handleAccountRequest(request(`${path}/revoke`, 'POST', { email: 'hidden@gmail.com' }, cookie), env, owner)).json(), { revoked: true });
  assert.equal(sqlite.prepare("SELECT state FROM jobs j JOIN messages m ON m.id = j.message_id WHERE m.sender_email = 'hidden@gmail.com'").get().state, 'failed');
  assert.deepEqual(await deliver('hidden-revoked', 'hidden@gmail.com', ['<owner-first@gmail.com>']), { accepted: false });
});
