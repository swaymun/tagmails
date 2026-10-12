import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { googleSignInConfigured, ownerAccount, verifyGoogleCredential } from './account-auth.mjs';
import { ICON_LINKS } from './brand-icons.mjs';
import { rateLimited, tooManyRequests } from './rate-limit.mjs';

// OAuth 2.1 authorization server for the MCP endpoint, per the MCP
// authorization spec: protected-resource and server metadata, dynamic client
// registration, an authorization code flow with PKCE (S256) whose consent step
// is the same Google sign-in the site uses, rotating refresh tokens and
// revocation. Clients are public (no secret); codes and tokens are stored as
// SHA-256 hashes.

export const MCP_SCOPES = ['tagmails.read', 'tagmails.manage'];
const ACCESS_SECONDS = 3600;
const ACCESS_TOKEN = /^tm_mcp_[A-Za-z0-9_-]{43}$/;
const REFRESH_TOKEN = /^tm_mcr_[A-Za-z0-9_-]{43}$/;
const AUTH_CODE = /^tm_code_[A-Za-z0-9_-]{43}$/;
const CLIENT_ID = /^tm_cli_[A-Za-z0-9_-]{22}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const UNSAFE_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:', 'ws:', 'wss:', 'ftp:']);
const MAX_BODY = 12_000;

// MCP clients call these from servers, CLIs and browsers alike, with bearer
// tokens rather than cookies, so any origin may read the responses.
export const OPEN_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
};

function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function json(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}
function oauthError(error, description, status = 400) {
  return json({ error, error_description: description }, status, OPEN_CORS);
}
const originOf = (request) => new URL(request.url).origin;
export const mcpResource = (request) => `${originOf(request)}/mcp`;
export const resourceMetadataUrl = (request) => `${originOf(request)}/.well-known/oauth-protected-resource/mcp`;

async function boundedText(request) {
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY) throw new Error('Request too large');
  const reader = request.body?.getReader();
  if (!reader) return '';
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
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// Token and revocation requests are form-encoded (RFC 6749); JSON is accepted too.
async function formParams(request) {
  const text = await boundedText(request);
  if ((request.headers.get('content-type') ?? '').includes('application/json')) {
    const body = JSON.parse(text || '{}');
    return new URLSearchParams(Object.entries(body).filter(([, value]) => typeof value === 'string'));
  }
  return new URLSearchParams(text);
}

// https anywhere, http only on loopback (RFC 8252 7.3), or a native app's
// private-use scheme (RFC 8252 7.1). Never a scheme that runs in this page.
function redirectUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.hash || url.username || url.password) return null;
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:') return LOOPBACK.has(url.hostname) ? url : null;
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && !UNSAFE_SCHEMES.has(url.protocol) ? url : null;
}

function registeredRedirect(redirectUris, requested) {
  const url = redirectUrl(requested);
  if (!url) return false;
  return redirectUris.some((value) => {
    if (value === requested) return true;
    const known = redirectUrl(value);
    // A loopback redirect may come back on any port (RFC 8252 7.3).
    return known?.protocol === 'http:' && url.protocol === 'http:' && LOOPBACK.has(known.hostname) &&
      known.hostname === url.hostname && known.pathname === url.pathname && known.search === url.search;
  });
}

function withParams(target, params) {
  const url = new URL(target);
  for (const [key, value] of Object.entries(params)) if (value != null) url.searchParams.set(key, value);
  return url.href;
}

// No scope means every scope. Unknown scopes are ignored; if nothing known is
// left, the client gets every scope, which the consent page lists.
function grantedScope(requested) {
  const known = String(requested ?? '').split(' ').filter((scope) => MCP_SCOPES.includes(scope));
  return (known.length ? MCP_SCOPES.filter((scope) => known.includes(scope)) : MCP_SCOPES).join(' ');
}

function resourceMatches(request, resource) {
  if (!resource) return true;
  const value = resource.replace(/\/+$/, '');
  return value === mcpResource(request) || value === originOf(request);
}

function protectedResourceMetadata(request) {
  return { resource: mcpResource(request), authorization_servers: [originOf(request)],
    scopes_supported: MCP_SCOPES, bearer_methods_supported: ['header'], resource_name: 'TagMails',
    resource_documentation: 'https://tagmails.com' };
}

function authorizationServerMetadata(request) {
  const origin = originOf(request);
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    scopes_supported: MCP_SCOPES,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    service_documentation: 'https://tagmails.com',
  };
}

async function register(request, env) {
  let body;
  try { body = JSON.parse(await boundedText(request)); }
  catch { return oauthError('invalid_client_metadata', 'Send the client metadata as JSON.'); }
  const uris = body?.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every((uri) => redirectUrl(uri))) {
    return oauthError('invalid_redirect_uri', 'Redirect URIs must be https, http on localhost, or an app scheme.');
  }
  const name = typeof body.client_name === 'string'
    ? body.client_name.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 80) : '';
  const id = `tm_cli_${randomBytes(16).toString('base64url')}`;
  await env.DB.prepare('INSERT INTO mcp_clients (id, name, redirect_uris_json) VALUES (?, ?, ?)')
    .bind(id, name, JSON.stringify(uris)).run();
  // Every client is public: it proves possession with PKCE, not a secret.
  return json({ client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name || undefined,
    redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    token_endpoint_auth_method: 'none' }, 201, OPEN_CORS);
}

// Validates an authorization request. `fatal` errors are shown on the page
// (the redirect can't be trusted); the rest go back to the client.
async function authorizationRequest(request, env, params) {
  const clientId = params.get('client_id');
  const client = CLIENT_ID.test(clientId ?? '')
    ? await env.DB.prepare('SELECT id, name, redirect_uris_json FROM mcp_clients WHERE id = ?').bind(clientId).first()
    : null;
  if (!client) return { fatal: 'This app is not registered with TagMails. Remove the connector and add it again.' };
  const redirectUri = params.get('redirect_uri');
  if (!registeredRedirect(JSON.parse(client.redirect_uris_json), redirectUri)) {
    return { fatal: 'The return address does not match this app’s registration.' };
  }
  const state = params.get('state');
  const fail = (error, description) => ({ redirect: withParams(redirectUri, {
    error, error_description: description, state, iss: originOf(request) }) });
  if (params.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only the code flow is supported.');
  const challenge = params.get('code_challenge');
  if (params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge ?? '')) {
    return fail('invalid_request', 'PKCE with S256 is required.');
  }
  if (!resourceMatches(request, params.get('resource'))) return fail('invalid_target', 'Unknown resource.');
  return { client: { id: client.id, name: client.name }, redirectUri, challenge, state,
    scope: grantedScope(params.get('scope')) };
}

const pageHeaders = (nonce) => ({
  'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
  'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}' https://accounts.google.com; style-src 'nonce-${nonce}' https://accounts.google.com; img-src https: data:; frame-src https://accounts.google.com; connect-src 'self' https://accounts.google.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function page(nonce, body, script = '') {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect · TagMails</title>${ICON_LINKS}
<style nonce="${nonce}">
  :root{font:16px/1.5 system-ui,sans-serif;color:#242424;background:#f7f4ed}
  body{margin:0}main{max-width:520px;margin:10vh auto;padding:0 20px 60px}
  h1{font-size:1.6rem;line-height:1.2;margin:0 0 16px}code{background:#efece4;border-radius:5px;padding:2px 5px;overflow-wrap:anywhere}
  ul{padding-left:20px}.muted{color:#62625c;font-size:.92rem}#status{min-height:1.5em;margin-top:16px}#googleButton{margin-top:20px}
</style>${script}</head><body><main>${body}</main></body></html>`;
}

function errorPage(message, status = 400) {
  const nonce = randomBytes(16).toString('base64');
  return new Response(page(nonce, `<h1>Can’t connect to TagMails</h1><p>${escapeHtml(message)}</p>`),
    { status, headers: pageHeaders(nonce) });
}

function consentPage(env, auth) {
  const nonce = randomBytes(16).toString('base64');
  const target = new URL(auth.redirectUri);
  const returnTo = target.protocol === 'https:' || target.protocol === 'http:' ? target.host : target.protocol.slice(0, -1);
  const scopes = auth.scope.split(' ');
  const abilities = [
    scopes.includes('tagmails.read') && 'See your agent address, paired computers, balance and runs.',
    scopes.includes('tagmails.manage') && 'Create pairing codes and $10 top-up links, and disconnect computers.',
  ].filter(Boolean);
  const body = `<h1>Connect ${escapeHtml(auth.client.name || 'this app')} to TagMails</h1>
<p>After you sign in, it can:</p><ul>${abilities.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
<p class="muted">It can’t send email or pay for anything. You’ll go back to <code>${escapeHtml(returnTo)}</code>. Continue only if you just added TagMails there.</p>
<div id="googleButton"></div><p id="status" role="status"></p>`;
  const script = `<script src="https://accounts.google.com/gsi/client" defer nonce="${nonce}"></script>
<script nonce="${nonce}" defer>
const status = (message) => { document.getElementById('status').textContent = message; };
window.addEventListener('load', () => {
  if (!window.google?.accounts?.id) { status('Google sign-in did not load. Reload this page.'); return; }
  google.accounts.id.initialize({ client_id: ${JSON.stringify(env.GOOGLE_CLIENT_ID).replace(/</g, '\\u003c')}, callback: async ({ credential }) => {
    status('Connecting…');
    try {
      const response = await fetch('/oauth/authorize', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential, query: location.search }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.redirect) { status(data.error || 'Sign-in failed. Try again.'); return; }
      status('Connected. Returning to the app…');
      location.assign(data.redirect);
    } catch { status('Sign-in failed. Check your connection and try again.'); }
  } });
  google.accounts.id.renderButton(document.getElementById('googleButton'), { theme: 'outline', size: 'large', text: 'signin_with' });
});
</script>`;
  return new Response(page(nonce, body, script), { headers: pageHeaders(nonce) });
}

async function approve(request, env, verifyIdentity) {
  if (request.headers.get('origin') !== originOf(request)) return json({ error: 'Invalid origin' }, 403);
  if (await rateLimited(env, 'AUTH_RATE_LIMIT', request, 'auth')) return tooManyRequests();
  let body;
  try { body = JSON.parse(await boundedText(request)); }
  catch { return json({ error: 'Invalid request' }, 400); }
  if (typeof body?.query !== 'string' || body.query.length > 8000) return json({ error: 'Invalid request' }, 400);
  const auth = await authorizationRequest(request, env, new URLSearchParams(body.query));
  if (auth.fatal) return json({ error: auth.fatal }, 400);
  if (auth.redirect) return json({ redirect: auth.redirect });
  let identity;
  try { identity = await verifyIdentity(body.credential, env.GOOGLE_CLIENT_ID); }
  catch { return json({ error: 'Google sign-in failed. Try again.' }, 401); }
  const owner = await ownerAccount(env, identity);
  if (owner.error) return json({ error: owner.error }, owner.status);
  const code = `tm_code_${randomBytes(32).toString('base64url')}`;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO mcp_auth_codes (code_hash, client_id, account_id, redirect_uri, code_challenge, scope, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+5 minutes'))`)
      .bind(hash(code), auth.client.id, owner.account.id, auth.redirectUri, auth.challenge, auth.scope),
    env.DB.prepare('UPDATE mcp_clients SET authorized_at = CURRENT_TIMESTAMP WHERE id = ? AND authorized_at IS NULL')
      .bind(auth.client.id),
  ]);
  return json({ redirect: withParams(auth.redirectUri, { code, state: auth.state, iss: originOf(request) }) });
}

async function issueTokens(env, grantId, scope) {
  const access = `tm_mcp_${randomBytes(32).toString('base64url')}`;
  const refresh = `tm_mcr_${randomBytes(32).toString('base64url')}`;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO mcp_tokens (token_hash, grant_id, kind, expires_at)
      VALUES (?, ?, 'access', datetime('now', '+${ACCESS_SECONDS} seconds'))`).bind(hash(access), grantId),
    env.DB.prepare(`INSERT INTO mcp_tokens (token_hash, grant_id, kind, expires_at)
      VALUES (?, ?, 'refresh', datetime('now', '+30 days'))`).bind(hash(refresh), grantId),
    env.DB.prepare('UPDATE mcp_grants SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').bind(grantId),
  ]);
  return json({ access_token: access, token_type: 'Bearer', expires_in: ACCESS_SECONDS,
    refresh_token: refresh, scope }, 200, { ...OPEN_CORS, Pragma: 'no-cache' });
}

const revokeGrant = (env, grantId) => env.DB.prepare(
  'UPDATE mcp_grants SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL').bind(grantId).run();

async function exchangeCode(env, params) {
  const code = params.get('code');
  if (!AUTH_CODE.test(code ?? '')) return null;
  const row = await env.DB.prepare(`UPDATE mcp_auth_codes SET used_at = CURRENT_TIMESTAMP
    WHERE code_hash = ? AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP
    RETURNING client_id, account_id, redirect_uri, code_challenge, scope`).bind(hash(code)).first();
  if (!row) {
    // A replayed code revokes whatever it was exchanged for (RFC 6749 4.1.2).
    const used = await env.DB.prepare('SELECT grant_id FROM mcp_auth_codes WHERE code_hash = ? AND grant_id IS NOT NULL')
      .bind(hash(code)).first();
    if (used) await revokeGrant(env, used.grant_id);
    return null;
  }
  const verifier = params.get('code_verifier');
  if (row.client_id !== params.get('client_id') || row.redirect_uri !== params.get('redirect_uri') ||
      !VERIFIER.test(verifier ?? '') ||
      createHash('sha256').update(verifier).digest('base64url') !== row.code_challenge) return null;
  const active = await env.DB.prepare('SELECT id FROM accounts WHERE id = ? AND active = 1').bind(row.account_id).first();
  if (!active) return null;
  const grantId = randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO mcp_grants (id, client_id, account_id, scope) VALUES (?, ?, ?, ?)')
      .bind(grantId, row.client_id, row.account_id, row.scope),
    env.DB.prepare('UPDATE mcp_auth_codes SET grant_id = ? WHERE code_hash = ?').bind(grantId, hash(code)),
  ]);
  return issueTokens(env, grantId, row.scope);
}

async function refreshTokens(env, params) {
  const token = params.get('refresh_token');
  if (!REFRESH_TOKEN.test(token ?? '')) return null;
  const row = await env.DB.prepare(`UPDATE mcp_tokens SET used_at = CURRENT_TIMESTAMP
    WHERE token_hash = ? AND kind = 'refresh' AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP
      AND grant_id IN (SELECT g.id FROM mcp_grants g JOIN accounts a ON a.id = g.account_id
        WHERE g.revoked_at IS NULL AND a.active = 1)
    RETURNING grant_id`).bind(hash(token)).first();
  if (!row) {
    // Refresh tokens rotate. One reused well after its rotation was probably
    // stolen, so the whole grant ends; a near-simultaneous retry does not.
    const reused = await env.DB.prepare(`SELECT grant_id FROM mcp_tokens WHERE token_hash = ? AND kind = 'refresh'
      AND used_at < datetime('now', '-60 seconds')`).bind(hash(token)).first();
    if (reused) await revokeGrant(env, reused.grant_id);
    return null;
  }
  const grant = await env.DB.prepare('SELECT id, client_id, scope FROM mcp_grants WHERE id = ?').bind(row.grant_id).first();
  if (grant?.client_id !== params.get('client_id')) return null;
  return issueTokens(env, grant.id, grant.scope);
}

async function tokenRequest(request, env) {
  let params;
  try { params = await formParams(request); }
  catch { return oauthError('invalid_request', 'Invalid token request.'); }
  const grantType = params.get('grant_type');
  if (!['authorization_code', 'refresh_token'].includes(grantType)) {
    return oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token.');
  }
  const response = grantType === 'authorization_code' ? await exchangeCode(env, params) : await refreshTokens(env, params);
  if (response) return response;
  // Only failures count toward the per-IP limit: hosted clients share addresses.
  if (await rateLimited(env, 'AUTH_RATE_LIMIT', request, 'auth')) return tooManyRequests(OPEN_CORS);
  return oauthError('invalid_grant', 'The code or refresh token is invalid, expired or already used.');
}

// RFC 7009: holding a token is enough to end its grant. Always 200.
async function revokeRequest(request, env) {
  let params;
  try { params = await formParams(request); }
  catch { return oauthError('invalid_request', 'Invalid revocation request.'); }
  const token = params.get('token') ?? '';
  if (ACCESS_TOKEN.test(token) || REFRESH_TOKEN.test(token)) {
    await env.DB.prepare(`UPDATE mcp_grants SET revoked_at = CURRENT_TIMESTAMP WHERE revoked_at IS NULL
      AND id = (SELECT grant_id FROM mcp_tokens WHERE token_hash = ?)`).bind(hash(token)).run();
  }
  return new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store', ...OPEN_CORS } });
}

// The grant behind a bearer token on /mcp, or null.
export async function mcpGrantFor(request, env) {
  const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1];
  if (!ACCESS_TOKEN.test(token ?? '')) return null;
  const row = await env.DB.prepare(`SELECT g.id AS grant_id, g.scope, a.id, a.owner_email, a.agent_email, a.default_model
    FROM mcp_tokens t JOIN mcp_grants g ON g.id = t.grant_id JOIN accounts a ON a.id = g.account_id
    WHERE t.token_hash = ? AND t.kind = 'access' AND t.expires_at > CURRENT_TIMESTAMP
      AND g.revoked_at IS NULL AND a.active = 1 LIMIT 1`).bind(hash(token)).first();
  if (!row) return null;
  const { grant_id: grantId, scope, ...account } = row;
  return { grantId, scopes: new Set(scope.split(' ')), account };
}

export async function deleteExpiredMcpRows(env) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM mcp_auth_codes WHERE expires_at < datetime('now', '-1 day')").bind(),
    env.DB.prepare(`DELETE FROM mcp_tokens WHERE expires_at < CURRENT_TIMESTAMP
      OR grant_id IN (SELECT id FROM mcp_grants WHERE revoked_at IS NOT NULL)`).bind(),
    env.DB.prepare(`DELETE FROM mcp_grants WHERE created_at < datetime('now', '-1 day')
      AND NOT EXISTS (SELECT 1 FROM mcp_tokens t WHERE t.grant_id = mcp_grants.id)`).bind(),
    env.DB.prepare(`DELETE FROM mcp_clients WHERE authorized_at IS NULL AND created_at < datetime('now', '-1 day')
      AND NOT EXISTS (SELECT 1 FROM mcp_auth_codes c WHERE c.client_id = mcp_clients.id)`).bind(),
  ]);
}

export async function handleOAuthRequest(request, env, { verifyIdentity = verifyGoogleCredential } = {}) {
  const { pathname } = new URL(request.url);
  const metadata = {
    '/.well-known/oauth-protected-resource': protectedResourceMetadata,
    '/.well-known/oauth-protected-resource/mcp': protectedResourceMetadata,
    '/.well-known/oauth-authorization-server': authorizationServerMetadata,
    '/.well-known/oauth-authorization-server/mcp': authorizationServerMetadata,
  }[pathname];
  const endpoint = ['/oauth/authorize', '/oauth/token', '/oauth/register', '/oauth/revoke'].includes(pathname);
  if (!metadata && !endpoint) return null;
  if (request.method === 'OPTIONS' && pathname !== '/oauth/authorize') {
    return new Response(null, { status: 204, headers: OPEN_CORS });
  }
  if (metadata) {
    return request.method === 'GET' ? json(metadata(request), 200, { ...OPEN_CORS, 'Cache-Control': 'public, max-age=300' })
      : new Response('Not found', { status: 404 });
  }
  if (!env.DB) throw new Error('Account database is not configured');
  if (pathname === '/oauth/authorize') {
    if (!googleSignInConfigured(env)) return errorPage('Google sign-in is not configured on this relay.', 503);
    if (request.method === 'POST') return approve(request, env, verifyIdentity);
    if (request.method !== 'GET') return new Response('Not found', { status: 404 });
    const auth = await authorizationRequest(request, env, new URL(request.url).searchParams);
    if (auth.fatal) return errorPage(auth.fatal);
    if (auth.redirect) return Response.redirect(auth.redirect, 302);
    return consentPage(env, auth);
  }
  if (request.method !== 'POST') return new Response('Not found', { status: 404 });
  if (pathname === '/oauth/register') return register(request, env);
  if (pathname === '/oauth/token') return tokenRequest(request, env);
  return revokeRequest(request, env);
}
