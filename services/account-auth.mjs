import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { runReceiptPage } from './account-page.mjs';

const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const DEVICE_TOKEN = /^tm_dev_[A-Za-z0-9_-]{43}$/;
const PAIR_CODE = /^tm_pair_[A-Za-z0-9_-]{27}$/;
const SESSION_COOKIE = '__Host-tm_session';
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function json(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}
function sameOrigin(request) {
  return request.headers.get('origin') === new URL(request.url).origin;
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

async function accountFor(request, env) {
  const token = sessionToken(request);
  if (!token) return null;
  return env.DB.prepare(`SELECT a.id, a.owner_email, a.agent_email FROM sessions s
    JOIN accounts a ON a.id = s.account_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP
      AND a.active = 1 LIMIT 1`).bind(hash(token)).first();
}

async function signIn(request, env, verifyIdentity) {
  if (!sameOrigin(request)) return json({ error: 'Invalid origin' }, 403);
  if (!env.GOOGLE_CLIENT_ID || !DOMAIN.test(env.AGENT_DOMAIN ?? '')) return json({ error: 'Google sign-in is not configured' }, 503);
  let identity;
  try {
    const body = await bodyJson(request);
    identity = await verifyIdentity(body.credential, env.GOOGLE_CLIENT_ID);
  } catch { return json({ error: 'Google sign-in failed' }, 401); }
  const existing = await env.DB.prepare('SELECT id, active FROM accounts WHERE google_sub = ?')
    .bind(identity.sub).first();
  if (existing && !existing.active) return json({ error: 'Account is inactive' }, 403);
  if (existing) {
    try {
      await env.DB.prepare('UPDATE accounts SET owner_email = ? WHERE id = ?')
        .bind(identity.email, existing.id).run();
    } catch { return json({ error: 'Gmail address is already assigned' }, 409); }
  } else {
    const agent = `u-${randomUUID().replaceAll('-', '').slice(0, 20)}@${env.AGENT_DOMAIN}`;
    try {
      await env.DB.prepare('INSERT INTO accounts (id, google_sub, owner_email, agent_email) VALUES (?, ?, ?, ?)')
        .bind(randomUUID(), identity.sub, identity.email, agent).run();
    } catch {
      // A concurrent sign-in for the same Google account may have won.
      const raced = await env.DB.prepare('SELECT id FROM accounts WHERE google_sub = ?')
        .bind(identity.sub).first();
      if (!raced) return json({ error: 'Gmail address is already assigned' }, 409);
    }
  }
  const account = await env.DB.prepare('SELECT id, owner_email, agent_email FROM accounts WHERE google_sub = ? AND active = 1')
    .bind(identity.sub).first();
  if (!account || account.owner_email !== identity.email) return json({ error: 'Account could not be created' }, 409);
  const token = randomBytes(32).toString('base64url');
  await env.DB.prepare("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))")
    .bind(hash(token), account.id).run();
  return json({ ownerEmail: account.owner_email, agentEmail: account.agent_email }, 200, {
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

export async function handleAccountRequest(request, env, { verifyIdentity = verifyGoogleCredential } = {}) {
  const { pathname } = new URL(request.url);
  const runId = pathname.match(/^\/runs\/([0-9a-f-]{36})$/i)?.[1];
  if (!pathname.startsWith('/api/auth/') && !pathname.startsWith('/api/account/') && pathname !== '/api/device/pair' && !runId) return null;
  if (!env.DB) throw new Error('Account database is not configured');
  if (pathname === '/api/auth/config' && request.method === 'GET') {
    return env.GOOGLE_CLIENT_ID && DOMAIN.test(env.AGENT_DOMAIN ?? '')
      ? json({ clientId: env.GOOGLE_CLIENT_ID })
      : json({ error: 'Google sign-in is not configured' }, 503);
  }
  if (pathname === '/api/auth/google' && request.method === 'POST') return signIn(request, env, verifyIdentity);
  if (pathname === '/api/device/pair' && request.method === 'POST') return pair(request, env);
  const account = await accountFor(request, env);
  if (runId && request.method === 'GET') {
    if (!account) return Response.redirect(`${new URL(request.url).origin}/account?next=${encodeURIComponent(pathname)}`, 302);
    const row = await env.DB.prepare(`SELECT j.id, j.state, j.attempts, j.created_at, j.result_key,
      t.subject, m.sender_email, o.state AS delivery_state
      FROM jobs j JOIN threads t ON t.id = j.thread_id JOIN messages m ON m.id = j.message_id
      LEFT JOIN outbox o ON o.job_id = j.id
      WHERE j.id = ? AND t.account_id = ? LIMIT 1`).bind(runId, account.id).first();
    if (!row) return new Response('Run not found', { status: 404 });
    const saved = row.result_key ? await env.MAIL.get(row.result_key) : null;
    const result = saved ? JSON.parse(new TextDecoder().decode(await saved.arrayBuffer())) : null;
    return runReceiptPage({ ...row, result });
  }
  if (pathname === '/api/account/me' && request.method === 'GET') {
    return account ? json({ ownerEmail: account.owner_email, agentEmail: account.agent_email,
      deliveryReady: env.MAIL_DELIVERY_READY === 'true' }) : json({ error: 'Sign in required' }, 401);
  }
  if (pathname === '/api/account/devices' && request.method === 'GET') {
    if (!account) return json({ error: 'Sign in required' }, 401);
    const rows = await env.DB.prepare(`SELECT id, name, created_at, revoked_at FROM devices
      WHERE account_id = ? ORDER BY created_at DESC`).bind(account.id).all();
    return json({ devices: rows.results ?? rows });
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
  if (pathname === '/api/account/pairing-code') {
    const code = `tm_pair_${randomBytes(20).toString('base64url')}`;
    await env.DB.prepare("INSERT INTO pairing_codes (code_hash, account_id, expires_at) VALUES (?, ?, datetime('now', '+10 minutes'))")
      .bind(hash(code), account.id).run();
    return json({ code, expiresInSeconds: 600 });
  }
  const revoke = pathname.match(/^\/api\/account\/devices\/([0-9a-f-]{36})\/revoke$/i);
  if (revoke) {
    const result = await env.DB.prepare('UPDATE devices SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND account_id = ? AND revoked_at IS NULL')
      .bind(revoke[1], account.id).run();
    return (result.meta?.changes ?? result.changes) ? json({ revoked: true }) : json({ error: 'Device not found' }, 404);
  }
  return new Response('Not found', { status: 404 });
}
