import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { runReceiptPage } from './account-page.mjs';
import { selectedModelDetail, selectedModelStatus } from './model-route.mjs';
import { addressDomain, checkAddress, chooseAddress } from './agent-username.mjs';
import { openText } from './storage-crypto.mjs';
import { artifactForDownload, selectedRunArtifacts } from './run-artifacts.mjs';
import { knownAgentAddresses } from './agent-addresses.mjs';
import { accountPreferences, saveAccountPreferences } from './account-preferences.mjs';
import { accountModelCatalog } from './model-catalog.mjs';

const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const DEVICE_TOKEN = /^tm_dev_[A-Za-z0-9_-]{43}$/;
const PAIR_CODE = /^tm_pair_[A-Za-z0-9_-]{27}$/;
const SESSION_COOKIE = '__Host-tm_session';
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PARTICIPANT_EMAIL = /^[a-z0-9][a-z0-9._%+-]*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function json(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}
export function sameOrigin(request) {
  return request.headers.get('origin') === new URL(request.url).origin;
}
export function siteOriginFor(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  for (const value of [env.SITE_ORIGIN, ...(env.SITE_ALLOWED_ORIGINS ?? '').split(',')]) {
    try {
      const url = new URL(value.trim());
      const local = ['localhost', '127.0.0.1'].includes(url.hostname);
      if ((url.protocol === 'https:' || (local && url.protocol === 'http:' && url.port)) &&
          url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password &&
          url.origin === origin) return origin;
    } catch { /* Ignore an unset or malformed configured origin. */ }
  }
  return null;
}
function sessionToken(request) {
  const cookies = request.headers.get('cookie') ?? '';
  const value = cookies.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value ?? '') ? value : null;
}
async function bodyJson(request) {
  if (Number(request.headers.get('content-length') || 0) > 12_000) throw new Error('Request too large');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing body');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 12_000) { await reader.cancel(); throw new Error('Request too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
}

export async function verifyGoogleCredential(credential, clientId, keys = googleKeys) {
  if (typeof credential !== 'string' || credential.length > 10_000 || !clientId) throw new Error('Invalid Google credential');
  const { payload } = await jwtVerify(credential, keys, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: clientId,
    algorithms: ['RS256'],
    clockTolerance: '30 seconds',
    maxTokenAge: '1 hour',
  });
  const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
  if (!payload.sub || typeof payload.sub !== 'string' ||
      !/^[^\s@]+@gmail\.com$/.test(email) ||
      ![true, 'true'].includes(payload.email_verified) ||
      (payload.azp && payload.azp !== clientId)) {
    throw new Error('A verified personal Gmail account is required');
  }
  return { sub: payload.sub, email };
}

export async function accountFor(request, env) {
  const token = sessionToken(request);
  if (!token) return null;
  return env.DB.prepare(`SELECT a.id, a.owner_email, a.agent_email, a.default_model FROM sessions s
    JOIN accounts a ON a.id = s.account_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP
      AND a.active = 1 LIMIT 1`).bind(hash(token)).first();
}

const SITE_SESSION = /^tm_ses_[A-Za-z0-9_-]{43}$/;

// Google's popup code flow: the browser never shows a personalized
// "Continue as" button, and the relay trades the code for an ID token.
export async function exchangeGoogleCode(env, code, fetcher = fetch) {
  if (!env.GOOGLE_CLIENT_SECRET || code.length > 2000) throw new Error('Google code sign-in is not configured');
  const response = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: 'postmessage', grant_type: 'authorization_code' }),
  });
  if (!response.ok) throw new Error('Google code exchange failed');
  const { id_token: idToken } = await response.json();
  if (typeof idToken !== 'string') throw new Error('Google returned no ID token');
  return idToken;
}

async function siteSessionAccount(env, token) {
  if (!SITE_SESSION.test(token ?? '')) return null;
  return env.DB.prepare(`SELECT a.id, a.google_sub, a.owner_email, a.agent_email, a.default_model FROM sessions s
    JOIN accounts a ON a.id = s.account_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP AND a.active = 1 LIMIT 1`)
    .bind(hash(token)).first();
}

// A site request proves who it is with a TagMails session or a Google ID token.
async function siteIdentity(env, credential, verifyIdentity) {
  const account = await siteSessionAccount(env, credential);
  if (account) return { sub: account.google_sub, email: account.owner_email };
  return verifyIdentity(credential, env.GOOGLE_CLIENT_ID);
}

async function signIn(request, env, verifyIdentity, exchangeCode) {
  const fromSite = Boolean(siteOriginFor(request, env));
  const headers = siteCors(request, env);
  if (!sameOrigin(request) && !fromSite) return json({ error: 'Invalid origin' }, 403);
  if (!env.GOOGLE_CLIENT_ID || !DOMAIN.test(env.AGENT_DOMAIN ?? '')) return json({ error: 'Google sign-in is not configured' }, 503, headers);
  let identity;
  try {
    const body = await bodyJson(request);
    const credential = typeof body.code === 'string' && fromSite
      ? await exchangeGoogleCode(env, body.code, exchangeCode) : body.credential;
    identity = await verifyIdentity(credential, env.GOOGLE_CLIENT_ID);
  } catch { return json({ error: 'Google sign-in failed' }, 401, headers); }
  if (env.PUBLIC_SIGNUP_ENABLED !== 'true' &&
      identity.email !== String(env.PILOT_OWNER_EMAIL ?? '').trim().toLowerCase()) {
    return json({ error: 'TagMails signup is closed during the private pilot' }, 403, headers);
  }
  const existing = await env.DB.prepare('SELECT id, active FROM accounts WHERE google_sub = ?')
    .bind(identity.sub).first();
  if (existing && !existing.active) return json({ error: 'Account is inactive' }, 403, headers);
  if (existing) {
    try {
      await env.DB.prepare('UPDATE accounts SET owner_email = ? WHERE id = ?')
        .bind(identity.email, existing.id).run();
    } catch { return json({ error: 'Gmail address is already assigned' }, 409, headers); }
  } else {
    const agent = `u-${randomUUID().replaceAll('-', '').slice(0, 20)}@${env.AGENT_DOMAIN}`;
    const accountId = randomUUID();
    try {
      await env.DB.prepare('INSERT INTO accounts (id, google_sub, owner_email, agent_email) VALUES (?, ?, ?, ?)')
        .bind(accountId, identity.sub, identity.email, agent).run();
    } catch {
      // A concurrent sign-in for the same Google account may have won.
      const raced = await env.DB.prepare('SELECT id FROM accounts WHERE google_sub = ?')
        .bind(identity.sub).first();
      if (!raced) return json({ error: 'Gmail address is already assigned' }, 409, headers);
    }
  }
  const account = await env.DB.prepare('SELECT id, owner_email, agent_email, default_model FROM accounts WHERE google_sub = ? AND active = 1')
    .bind(identity.sub).first();
  if (!account || account.owner_email !== identity.email) return json({ error: 'Account could not be created' }, 409, headers);
  if (fromSite) {
    // The site keeps a 30-day session so people stay signed in between visits.
    const sessionToken = `tm_ses_${randomBytes(32).toString('base64url')}`;
    await env.DB.prepare("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))")
      .bind(hash(sessionToken), account.id).run();
    return json({ sessionToken, agentEmail: account.agent_email }, 200, headers);
  }
  const token = randomBytes(32).toString('base64url');
  await env.DB.prepare("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))")
    .bind(hash(token), account.id).run();
  return json({ ownerEmail: account.owner_email, agentEmail: account.agent_email }, 200, {
    ...headers,
    'Set-Cookie': `${SESSION_COOKIE}=${token}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`,
  });
}

async function pair(request, env) {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    return json({ error: 'HTTPS required' }, 403);
  }
  let body;
  try { body = await bodyJson(request); }
  catch { return json({ error: 'Invalid pairing request' }, 400); }
  if (!PAIR_CODE.test(body.code ?? '') || !DEVICE_TOKEN.test(body.token ?? '') ||
      typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80) {
    return json({ error: 'Invalid pairing request' }, 400);
  }
  const claimed = await env.DB.prepare(`UPDATE pairing_codes SET used_at = CURRENT_TIMESTAMP
    WHERE code_hash = ? AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP
      AND account_id IN (SELECT id FROM accounts WHERE active = 1)
    RETURNING account_id`).bind(hash(body.code)).first();
  if (!claimed) return json({ error: 'Pairing code expired or already used' }, 409);
  const deviceId = randomUUID();
  await env.DB.prepare('INSERT INTO devices (id, account_id, token_hash, name) VALUES (?, ?, ?, ?)')
    .bind(deviceId, claimed.account_id, hash(body.token), body.name.trim()).run();
  return json({ paired: true, deviceId }, 201);
}

export function siteCors(request, env) {
  const origin = siteOriginFor(request, env);
  return origin ? {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Vary': 'Origin',
  } : {};
}

export async function siteOwnerFor(request, env, verifyIdentity = verifyGoogleCredential) {
  const credential = request.headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1];
  let identity;
  try { identity = await siteIdentity(env, credential, verifyIdentity); }
  catch { return { error: 'Google sign-in required', status: 401 }; }
  const account = await env.DB.prepare('SELECT id, owner_email, agent_email, default_model FROM accounts WHERE google_sub = ? AND active = 1')
    .bind(identity.sub).first();
  if (!account || account.owner_email !== identity.email) return { error: 'Account not found', status: 404 };
  return { account };
}

async function createPairingCode(env, accountId) {
  const code = `tm_pair_${randomBytes(20).toString('base64url')}`;
  await env.DB.prepare("INSERT INTO pairing_codes (code_hash, account_id, expires_at) VALUES (?, ?, datetime('now', '+10 minutes'))")
    .bind(hash(code), accountId).run();
  return { code, expiresInSeconds: 600 };
}

async function accountDevices(env, accountId) {
  const rows = await env.DB.prepare(`SELECT id, name, created_at, revoked_at, last_seen_at FROM devices
    WHERE account_id = ? ORDER BY created_at DESC`).bind(accountId).all();
  return { devices: rows.results ?? rows };
}

async function accountThreads(env, accountId) {
  const rows = await env.DB.prepare(`SELECT t.id, t.subject, t.created_at,
    (SELECT j.id FROM jobs j WHERE j.thread_id = t.id
      ORDER BY j.created_at DESC, j.rowid DESC LIMIT 1) AS latest_run_id,
    d.name AS device_name, d.revoked_at AS device_revoked_at,
    p.email AS participant_email, p.revoked_at
    FROM threads t LEFT JOIN devices d ON d.id = t.device_id
    LEFT JOIN participants p ON p.thread_id = t.id
    WHERE t.account_id = ? ORDER BY t.created_at DESC, t.id DESC, p.email LIMIT 200`)
    .bind(accountId).all();
  const threads = [];
  for (const row of rows.results ?? rows) {
    let thread = threads.at(-1);
    if (thread?.id !== row.id) {
      thread = { id: row.id, subject: await openText(env, row.subject), createdAt: row.created_at,
        latestRunId: row.latest_run_id, device: row.device_name
          ? { name: row.device_name, revokedAt: row.device_revoked_at } : null,
        participants: [] };
      threads.push(thread);
    }
    if (row.participant_email) thread.participants.push({ email: row.participant_email, revokedAt: row.revoked_at });
  }
  return { threads };
}

async function revokeAccountDevice(env, accountId, deviceId) {
  const [result] = await env.DB.batch([
    env.DB.prepare('UPDATE devices SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND account_id = ? AND revoked_at IS NULL')
      .bind(deviceId, accountId),
    env.DB.prepare(`UPDATE jobs SET state = 'failed', lease_until = NULL
      WHERE state IN ('queued', 'running') AND thread_id IN (
        SELECT id FROM threads WHERE account_id = ? AND device_id = ?)`).bind(accountId, deviceId),
    env.DB.prepare(`UPDATE test_email_charges SET state = 'released', updated_at = CURRENT_TIMESTAMP
      WHERE state = 'reserved' AND job_id IN (
        SELECT j.id FROM jobs j JOIN threads t ON t.id = j.thread_id
        WHERE t.account_id = ? AND t.device_id = ? AND j.state = 'failed'
          AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.job_id = j.id))`).bind(accountId, deviceId),
  ]);
  return (result.meta?.changes ?? result.changes) ? { revoked: true } : null;
}

async function changeDefaultModel(request, env, accountId, headers = {}) {
  let model;
  try { model = (await bodyJson(request)).model; }
  catch { return json({ error: 'Invalid model request' }, 400, headers); }
  if (!['gpt-6.1-sol', 'claude-sonnet-5-5'].includes(model)) return json({ error: 'Choose Codex or Claude' }, 400, headers);
  const changed = await env.DB.prepare('UPDATE accounts SET default_model = ? WHERE id = ? AND active = 1')
    .bind(model, accountId).run();
  if (!(changed.meta?.changes ?? changed.changes)) return json({ error: 'Account is inactive' }, 409, headers);
  return json({ defaultModel: model }, 200, headers);
}

async function changeParticipant(request, env, account, threadId, action, headers = {}) {
  let email;
  try { email = String((await bodyJson(request)).email ?? '').trim().toLowerCase(); }
  catch { return json({ error: 'Invalid request' }, 400, headers); }
  if (email.length > 254 || email.includes('..') || !PARTICIPANT_EMAIL.test(email) ||
      email === account.owner_email || email === account.agent_email) {
    return json({ error: 'Invalid participant email' }, 400, headers);
  }
  if ((await knownAgentAddresses(env.DB, [email])).has(email)) {
    return json({ error: 'An agent address cannot join as a participant' }, 400, headers);
  }
  const thread = await env.DB.prepare('SELECT id FROM threads WHERE id = ? AND account_id = ?')
    .bind(threadId, account.id).first();
  if (!thread) return json({ error: 'Thread not found' }, 404, headers);
  if (action.toLowerCase() === 'invite') {
    await env.DB.prepare(`INSERT INTO participants (thread_id, email) VALUES (?, ?)
      ON CONFLICT(thread_id, email) DO UPDATE SET revoked_at = NULL`).bind(threadId, email).run();
    return json({ invited: true }, 200, headers);
  }
  const [changed] = await env.DB.batch([
    env.DB.prepare(`UPDATE participants SET revoked_at = CURRENT_TIMESTAMP
      WHERE thread_id = ? AND email = ? AND revoked_at IS NULL`).bind(threadId, email),
    env.DB.prepare(`UPDATE jobs SET state = 'failed', lease_until = NULL
      WHERE thread_id = ? AND state IN ('queued', 'running') AND message_id IN (
        SELECT id FROM messages WHERE thread_id = ? AND sender_email = ?)`)
      .bind(threadId, threadId, email),
    env.DB.prepare(`UPDATE test_email_charges SET state = 'released', updated_at = CURRENT_TIMESTAMP
      WHERE state = 'reserved' AND job_id IN (
        SELECT j.id FROM jobs j JOIN messages m ON m.id = j.message_id
        WHERE j.thread_id = ? AND j.state = 'failed' AND m.sender_email = ?
          AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.job_id = j.id
            AND o.state NOT IN ('blocked', 'queued')))`)
      .bind(threadId, email),
  ]);
  if (!(changed.meta?.changes ?? changed.changes)) return json({ error: 'Active participant not found' }, 404, headers);
  return json({ revoked: true }, 200, headers);
}

async function siteAccountRequest(request, env, pathname, verifyIdentity) {
  const headers = siteCors(request, env);
  if (request.method === 'OPTIONS') return new Response(null, {
    status: siteOriginFor(request, env) ? 204 : 403, headers,
  });
  if (!siteOriginFor(request, env)) return json({ error: 'Invalid origin' }, 403);
  const owner = await siteOwnerFor(request, env, verifyIdentity);
  if (owner.error) return json({ error: owner.error }, owner.status, headers);
  const { account } = owner;
  if (pathname === '/api/site/account' && request.method === 'GET') {
    return json({ ownerEmail: account.owner_email, agentEmail: account.agent_email,
      defaultModel: account.default_model, deliveryReady: env.MAIL_DELIVERY_READY === 'true',
      addressDomain: addressDomain(env) }, 200, headers);
  }
  if (pathname === '/api/site/address' && request.method === 'GET') {
    return json(await checkAddress(env, account, new URL(request.url).searchParams.get('name')), 200, headers);
  }
  if (pathname === '/api/site/address' && request.method === 'POST') {
    let body;
    try { body = await bodyJson(request); } catch { return json({ error: 'Invalid request' }, 400, headers); }
    const result = await chooseAddress(env, account, body?.name);
    return result.error ? json({ error: result.error }, result.status, headers) : json(result, 200, headers);
  }
  if (pathname === '/api/site/default-model' && request.method === 'POST') {
    return changeDefaultModel(request, env, account.id, headers);
  }
  if (pathname === '/api/site/preferences' && request.method === 'GET') {
    return json(await accountPreferences(env, account), 200, headers);
  }
  if (pathname === '/api/site/models' && request.method === 'GET') {
    return json(await accountModelCatalog(env.DB, account.id), 200, headers);
  }
  if (pathname === '/api/site/preferences' && request.method === 'POST') {
    try { return json(await saveAccountPreferences(env, account, await bodyJson(request)), 200, headers); }
    catch (error) { return json({ error: error.message }, 400, headers); }
  }
  if (pathname === '/api/site/devices' && request.method === 'GET') {
    return json(await accountDevices(env, account.id), 200, headers);
  }
  if (pathname === '/api/site/threads' && request.method === 'GET') {
    return json(await accountThreads(env, account.id), 200, headers);
  }
  const threadTranscriptId = pathname.match(/^\/api\/site\/threads\/([0-9a-f-]{36})\/transcript$/i)?.[1];
  if (threadTranscriptId && request.method === 'GET') {
    return threadTranscriptPage(env, account.id, threadTranscriptId,
      new URL(request.url).searchParams.get('before'), headers);
  }
  const participantAction = pathname.match(/^\/api\/site\/threads\/([0-9a-f-]{36})\/(invite|revoke)$/i);
  if (participantAction && request.method === 'POST') {
    return changeParticipant(request, env, account, participantAction[1], participantAction[2], headers);
  }
  if (pathname === '/api/site/logout' && request.method === 'POST') {
    const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1];
    if (SITE_SESSION.test(token ?? '')) {
      await env.DB.prepare('UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ? AND account_id = ?')
        .bind(hash(token), account.id).run();
    }
    return json({ signedOut: true }, 200, headers);
  }
  if (pathname === '/api/site/pairing-code' && request.method === 'POST') {
    return json(await createPairingCode(env, account.id), 200, headers);
  }
  const revoke = pathname.match(/^\/api\/site\/devices\/([0-9a-f-]{36})\/revoke$/i);
  if (revoke && request.method === 'POST') {
    const result = await revokeAccountDevice(env, account.id, revoke[1]);
    return result ? json(result, 200, headers) : json({ error: 'Device not found' }, 404, headers);
  }
  return json({ error: 'Not found' }, 404, headers);
}

async function runRow(env, runId, accountId) {
  const row = await env.DB.prepare(`SELECT j.id, j.thread_id, j.state, j.attempts, j.created_at, j.result_key, j.model_json,
    j.workspace_json, t.subject, m.sender_email, o.state AS delivery_state, o.provider_email_id
    FROM jobs j JOIN threads t ON t.id = j.thread_id JOIN messages m ON m.id = j.message_id
    LEFT JOIN outbox o ON o.job_id = j.id
    WHERE j.id = ? AND t.account_id = ? LIMIT 1`).bind(runId, accountId).first();
  if (!row) return null;
  const saved = row.result_key ? await env.MAIL.get(row.result_key) : null;
  const result = saved ? JSON.parse(new TextDecoder().decode(await saved.arrayBuffer())) : null;
  const artifacts = await selectedRunArtifacts(env, accountId, runId, result?.artifactIds);
  const deliveries = row.provider_email_id ? await env.DB.prepare(`SELECT recipient_email, status FROM delivery_recipients
    WHERE job_id = ? AND provider_email_id = ? ORDER BY recipient_email`)
    .bind(runId, row.provider_email_id).all() : { results: [] };
  let project = null;
  try { project = JSON.parse(row.workspace_json ?? 'null')?.name ?? null; } catch { /* Older runs have no folder. */ }
  row.subject = await openText(env, row.subject);
  return { ...row, selectedModel: selectedModelDetail(row.model_json), model: selectedModelStatus(row.model_json),
    project, result, artifacts,
    deliveryRecipients: deliveries.results ?? deliveries };
}

async function recentThreadRuns(env, threadId, accountId) {
  const rows = await env.DB.prepare(`SELECT j.id, j.state, j.created_at, m.sender_email
    FROM jobs j JOIN messages m ON m.id = j.message_id
    JOIN threads t ON t.id = j.thread_id
    WHERE j.thread_id = ? AND t.account_id = ?
    ORDER BY j.created_at DESC, j.id DESC LIMIT 20`)
    .bind(threadId, accountId).all();
  return (rows.results ?? rows).reverse().map((row) => ({ id: row.id, state: row.state,
    createdAt: row.created_at, sender: row.sender_email }));
}

function visibleTranscript(value) {
  if (value?.version !== 1 || !Array.isArray(value.events)) return null;
  return { version: 1, truncated: value.truncated === true,
    events: value.events.slice(0, 48).flatMap((event) =>
      event && ['request', 'assistant', 'tool', 'reasoning'].includes(event.kind) && typeof event.text === 'string'
        ? [{ kind: event.kind,
          ...(event.kind === 'assistant' && ['commentary', 'final_answer'].includes(event.phase)
            ? { phase: event.phase } : {}),
          text: event.text.slice(0, event.kind === 'assistant' && event.phase !== 'commentary' ? 8000 : 800) }]
        : []) };
}

async function threadTranscriptPage(env, accountId, threadId, before, headers) {
  const thread = await env.DB.prepare('SELECT id, subject FROM threads WHERE id = ? AND account_id = ?')
    .bind(threadId, accountId).first();
  if (!thread) return json({ error: 'Thread not found' }, 404, headers);
  thread.subject = await openText(env, thread.subject);
  let cursor = null;
  if (before !== null) {
    if (!/^[0-9a-f-]{36}$/i.test(before)) return json({ error: 'Invalid cursor' }, 400, headers);
    cursor = await env.DB.prepare('SELECT id, created_at FROM jobs WHERE id = ? AND thread_id = ?')
      .bind(before, threadId).first();
    if (!cursor) return json({ error: 'Invalid cursor' }, 400, headers);
  }
  const rows = await env.DB.prepare(`SELECT j.id, j.state, j.created_at, j.result_key, j.model_json,
    m.sender_email FROM jobs j JOIN messages m ON m.id = j.message_id
    WHERE j.thread_id = ? AND (? IS NULL OR j.created_at < ? OR (j.created_at = ? AND j.id < ?))
    ORDER BY j.created_at DESC, j.id DESC LIMIT 21`)
    .bind(threadId, cursor?.created_at ?? null, cursor?.created_at ?? null,
      cursor?.created_at ?? null, cursor?.id ?? null).all();
  const page = (rows.results ?? rows).slice(0, 20);
  const runs = await Promise.all(page.map(async (row) => {
    const saved = row.result_key ? await env.MAIL.get(row.result_key) : null;
    let result = null;
    if (saved) {
      try { result = JSON.parse(new TextDecoder().decode(await saved.arrayBuffer())); }
      catch { /* An unreadable result must not break the rest of the thread. */ }
    }
    return { id: row.id, state: row.state, createdAt: row.created_at,
      sender: row.sender_email, selectedModel: selectedModelDetail(row.model_json),
      summary: typeof result?.summary === 'string' ? result.summary : null,
      transcript: visibleTranscript(result?.transcript) };
  }));
  return json({ thread, runs: runs.reverse(),
    nextBefore: (rows.results ?? rows).length > 20 ? page.at(-1).id : null }, 200, headers);
}

async function runViewer(env, runId, identity) {
  const viewer = await env.DB.prepare(`SELECT t.account_id, a.google_sub, a.owner_email,
    p.email AS participant_email, o.payload_json
    FROM jobs j JOIN threads t ON t.id = j.thread_id JOIN accounts a ON a.id = t.account_id
    LEFT JOIN participants p ON p.thread_id = t.id AND p.email = ? AND p.revoked_at IS NULL
    LEFT JOIN outbox o ON o.job_id = j.id
    WHERE j.id = ? AND a.active = 1 LIMIT 1`).bind(identity.email, runId).first();
  if (!viewer) return null;
  if (viewer.google_sub === identity.sub && viewer.owner_email === identity.email) {
    return { accountId: viewer.account_id, owner: true };
  }
  if (viewer.participant_email !== identity.email || !viewer.payload_json) return null;
  let payload;
  try { payload = JSON.parse(viewer.payload_json); }
  catch { return null; }
  const recipients = [...(Array.isArray(payload.to) ? payload.to : []),
    ...(Array.isArray(payload.cc) ? payload.cc : [])];
  return recipients.includes(identity.email) ? { accountId: viewer.account_id, owner: false } : null;
}

function participantResult(result) {
  if (!result) return null;
  const { state, summary, details, answer, checks, runtime, transcript } = result;
  return { state, summary, details, answer, checks, runtime, transcript };
}

async function artifactResponse(env, accountId, row, artifactId, headers = {}) {
  if (!row.result?.artifactIds?.includes(artifactId)) return json({ error: 'File not found' }, 404, headers);
  const file = await artifactForDownload(env, accountId, row.id, artifactId);
  const object = file ? await env.MAIL.get(file.object_key) : null;
  if (!object) return json({ error: 'File not found' }, 404, headers);
  return new Response(object.body ?? await object.arrayBuffer(), { headers: {
    ...headers, 'Cache-Control': 'private, no-store', 'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    'X-Content-Type-Options': 'nosniff',
  } });
}

export async function handleAccountRequest(request, env, { verifyIdentity = verifyGoogleCredential, exchangeCode = fetch } = {}) {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith('/api/site/')) {
    if (!env.DB) throw new Error('Account database is not configured');
    return siteAccountRequest(request, env, pathname, verifyIdentity);
  }
  const runId = pathname.match(/^\/runs\/([0-9a-f-]{36})$/i)?.[1];
  const receiptArtifact = pathname.match(/^\/runs\/([0-9a-f-]{36})\/artifacts\/([0-9a-f-]{36})$/i);
  const apiRunId = pathname.match(/^\/api\/runs\/([0-9a-f-]{36})$/i)?.[1];
  const apiArtifact = pathname.match(/^\/api\/runs\/([0-9a-f-]{36})\/artifacts\/([0-9a-f-]{36})$/i);
  if (!pathname.startsWith('/api/auth/') && !pathname.startsWith('/api/account/') && pathname !== '/api/device/pair' && !runId && !receiptArtifact && !apiRunId && !apiArtifact) return null;
  if (!env.DB) throw new Error('Account database is not configured');
  if (pathname === '/api/auth/google' && request.method === 'OPTIONS') return new Response(null, {
    status: siteOriginFor(request, env) ? 204 : 403,
    headers: siteCors(request, env),
  });
  if ((apiRunId || apiArtifact) && request.method === 'OPTIONS') return new Response(null, {
    status: siteOriginFor(request, env) ? 204 : 403,
    headers: siteCors(request, env),
  });
  if ((apiRunId || apiArtifact) && request.method === 'GET') {
    const headers = siteCors(request, env);
    const credential = request.headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1];
    let identity;
    try { identity = await siteIdentity(env, credential, verifyIdentity); }
    catch { return json({ error: 'Google sign-in required' }, 401, headers); }
    const jobId = apiRunId ?? apiArtifact[1];
    const viewer = await runViewer(env, jobId, identity);
    if (apiArtifact && !viewer?.owner) return json({ error: 'Run not found' }, 404, headers);
    const row = viewer ? await runRow(env, jobId, viewer.accountId) : null;
    if (!row) return json({ error: 'Run not found' }, 404, headers);
    if (apiArtifact) return artifactResponse(env, viewer.accountId, row, apiArtifact[2], headers);
    return json({ id: row.id, state: row.state, subject: row.subject, sender: row.sender_email,
      selectedModel: row.selectedModel, model: row.model,
      ...(viewer.owner ? { project: row.project } : {}),
      createdAt: row.created_at, attempts: viewer.owner ? row.attempts : undefined,
      ...(viewer.owner ? { threadId: row.thread_id } : {}),
      ...(viewer.owner ? { threadRuns: await recentThreadRuns(env, row.thread_id, viewer.accountId) } : {}),
      deliveryState: row.delivery_state,
      deliveryRecipients: row.deliveryRecipients.filter((item) => viewer.owner || item.recipient_email === identity.email)
        .map((item) => ({ email: item.recipient_email, status: item.status })),
      result: viewer.owner ? row.result : participantResult(row.result),
      artifacts: viewer.owner ? row.artifacts.map((file) => ({ id: file.id, name: file.name,
        mimeType: file.mime_type, size: file.byte_size, expiresAt: file.expires_at })) : [] }, 200, headers);
  }
  if (pathname === '/api/auth/config' && request.method === 'GET') {
    return env.GOOGLE_CLIENT_ID && DOMAIN.test(env.AGENT_DOMAIN ?? '')
      ? json({ clientId: env.GOOGLE_CLIENT_ID }, 200, siteCors(request, env))
      : json({ error: 'Google sign-in is not configured' }, 503, siteCors(request, env));
  }
  if (pathname === '/api/auth/google' && request.method === 'POST') return signIn(request, env, verifyIdentity, exchangeCode);
  if (pathname === '/api/device/pair' && request.method === 'POST') return pair(request, env);
  const account = await accountFor(request, env);
  if (receiptArtifact && request.method === 'GET') {
    if (!account) return Response.redirect(`${new URL(request.url).origin}/account?next=${encodeURIComponent(pathname)}`, 302);
    const row = await runRow(env, receiptArtifact[1], account.id);
    return row ? artifactResponse(env, account.id, row, receiptArtifact[2])
      : new Response('Run not found', { status: 404 });
  }
  if (runId && request.method === 'GET') {
    if (!account) return Response.redirect(`${new URL(request.url).origin}/account?next=${encodeURIComponent(pathname)}`, 302);
    const row = await runRow(env, runId, account.id);
    if (!row) return new Response('Run not found', { status: 404 });
    return runReceiptPage(row);
  }
  if (pathname === '/api/account/me' && request.method === 'GET') {
    return account ? json({ ownerEmail: account.owner_email, agentEmail: account.agent_email,
      defaultModel: account.default_model, deliveryReady: env.MAIL_DELIVERY_READY === 'true' }) : json({ error: 'Sign in required' }, 401);
  }
  if (pathname === '/api/account/devices' && request.method === 'GET') {
    if (!account) return json({ error: 'Sign in required' }, 401);
    return json(await accountDevices(env, account.id));
  }
  if (pathname === '/api/account/models' && request.method === 'GET') {
    if (!account) return json({ error: 'Sign in required' }, 401);
    return json(await accountModelCatalog(env.DB, account.id));
  }
  if (pathname === '/api/account/threads' && request.method === 'GET') {
    if (!account) return json({ error: 'Sign in required' }, 401);
    return json(await accountThreads(env, account.id));
  }
  if (request.method !== 'POST') return new Response('Not found', { status: 404 });
  if (!sameOrigin(request)) return json({ error: 'Invalid origin' }, 403);
  if (pathname === '/api/auth/logout') {
    const token = sessionToken(request);
    if (token) await env.DB.prepare('UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ?')
      .bind(hash(token)).run();
    return json({ signedOut: true }, 200, { 'Set-Cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` });
  }
  if (!account) return json({ error: 'Sign in required' }, 401);
  if (pathname === '/api/account/default-model') return changeDefaultModel(request, env, account.id);
  const participantAction = pathname.match(/^\/api\/account\/threads\/([0-9a-f-]{36})\/(invite|revoke)$/i);
  if (participantAction) {
    return changeParticipant(request, env, account, participantAction[1], participantAction[2]);
  }
  if (pathname === '/api/account/pairing-code') {
    return json(await createPairingCode(env, account.id));
  }
  const revoke = pathname.match(/^\/api\/account\/devices\/([0-9a-f-]{36})\/revoke$/i);
  if (revoke) {
    const result = await revokeAccountDevice(env, account.id, revoke[1]);
    return result ? json(result) : json({ error: 'Device not found' }, 404);
  }
  return new Response('Not found', { status: 404 });
}
