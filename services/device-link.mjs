import { createHash, randomInt } from 'node:crypto';
import { googleSignInConfigured, ownerAccount, registerDevice, verifyGoogleCredential } from './account-auth.mjs';
import { validPublicKey } from './device-sealing.mjs';
import { ICON_LINKS } from './brand-icons.mjs';
import { rateLimited, tooManyRequests } from './rate-limit.mjs';
import { setupSkill } from './setup-skill.mjs';

// Pairing by link: `tagmails pair` (no code) registers its new device token
// with POST /api/device/link and prints <site>/connect plus a short code. The
// owner opens the page, types the code and signs in with Google; the relay
// then adds the computer to that account. The computer polls GET
// /api/device/link with its token until then. The link carries the code, so
// one click and a Google sign-in approve it; the page names the computer and
// shows the code first, so a link someone else sent is easy to spot.

const DEVICE_TOKEN = /^tm_dev_[A-Za-z0-9_-]{43}$/;
const CODE_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ';
const CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/;
const LINK_MINUTES = 10;
const MAX_BODY = 12_000;

function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function json(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}
const normalizeCode = (value) => String(value ?? '').toUpperCase().replace(/[^A-Z]/g, '');
const displayCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;

async function bodyJson(request) {
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY) throw new Error('Request too large');
  const text = await request.text();
  if (text.length > MAX_BODY) throw new Error('Request too large');
  return JSON.parse(text);
}

function configuredOrigin(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    return url.protocol === 'https:' && url.pathname === '/' && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}

// The approval page lives on the Site's domain when there is one
// (tagmails.com/connect routes to this Worker), else on the relay itself.
const connectUrl = (request, env, code) =>
  `${configuredOrigin(env.SITE_ORIGIN) ?? new URL(request.url).origin}/connect?code=${displayCode(code)}`;

async function startLink(request, env) {
  if (await rateLimited(env, 'AUTH_RATE_LIMIT', request, 'auth')) return tooManyRequests();
  let body;
  try { body = await bodyJson(request); } catch { return json({ error: 'Invalid link request' }, 400); }
  if (!DEVICE_TOKEN.test(body?.token ?? '') || typeof body.name !== 'string' || !body.name.trim() ||
      body.name.length > 80 || (body.publicKey !== undefined && !validPublicKey(body.publicKey))) {
    return json({ error: 'Invalid link request' }, 400);
  }
  const code = Array.from({ length: 8 }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join('');
  try {
    await env.DB.prepare(`INSERT INTO device_links (token_hash, code, name, public_key, expires_at)
      VALUES (?, ?, ?, ?, datetime('now', '+${LINK_MINUTES} minutes'))`)
      .bind(hash(body.token), code, body.name.trim(), body.publicKey ?? null).run();
  } catch { return json({ error: 'This device token is already waiting for approval' }, 409); }
  return json({ code: displayCode(code), url: connectUrl(request, env, code), expiresInSeconds: LINK_MINUTES * 60, interval: 3 }, 201);
}

// Polled by the computer with its own token; it learns nothing else.
async function linkStatus(request, env) {
  const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1];
  if (!DEVICE_TOKEN.test(token ?? '')) return json({ error: 'Device token required' }, 401);
  const row = await env.DB.prepare(`SELECT code, approved_at, expires_at > CURRENT_TIMESTAMP AS live
    FROM device_links WHERE token_hash = ?`).bind(hash(token)).first();
  if (!row) return json({ state: 'unknown' }, 404);
  if (row.approved_at) return json({ state: 'approved' });
  if (!row.live) return json({ state: 'expired' }, 410);
  return json({ state: 'pending', code: displayCode(row.code), url: connectUrl(request, env, row.code) });
}

async function approve(request, env, verifyIdentity, sendEmail) {
  if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Invalid origin' }, 403);
  if (await rateLimited(env, 'AUTH_RATE_LIMIT', request, 'auth')) return tooManyRequests();
  let body;
  try { body = await bodyJson(request); } catch { return json({ error: 'Invalid request' }, 400); }
  const code = normalizeCode(body?.code);
  if (!CODE.test(code)) return json({ error: 'Enter the 8-letter code your computer shows.' }, 400);
  let identity;
  try { identity = await verifyIdentity(body.credential, env.GOOGLE_CLIENT_ID); }
  catch { return json({ error: 'Google sign-in failed. Try again.' }, 401); }
  const owner = await ownerAccount(env, identity);
  if (owner.error) return json({ error: owner.error }, owner.status);
  const link = await env.DB.prepare(`UPDATE device_links SET approved_at = CURRENT_TIMESTAMP, account_id = ?
    WHERE code = ? AND approved_at IS NULL AND expires_at > CURRENT_TIMESTAMP
    RETURNING token_hash, name, public_key`).bind(owner.account.id, code).first();
  if (!link) return json({ error: 'That code is wrong or expired. Run `tagmails pair` again for a new one.' }, 404);
  await registerDevice(env, owner.account.id, { tokenHash: link.token_hash, name: link.name, publicKey: link.public_key }, sendEmail);
  return json({ name: link.name, agentEmail: owner.account.agent_email });
}

// The computer a code from the link belongs to, while it waits for approval.
async function pendingLink(env, value) {
  const code = normalizeCode(value);
  if (!CODE.test(code)) return null;
  return env.DB.prepare(`SELECT code, name FROM device_links
    WHERE code = ? AND approved_at IS NULL AND expires_at > CURRENT_TIMESTAMP`).bind(code).first();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function connectPage(env, link, askedFor) {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect a computer · TagMails</title>${ICON_LINKS}
<style nonce="${nonce}">
  :root{font:16px/1.5 system-ui,sans-serif;color:#242424;background:#f7f4ed}
  body{margin:0}main{max-width:520px;margin:10vh auto;padding:0 20px 60px}
  h1{font-size:1.6rem;line-height:1.2;margin:0 0 16px}.muted{color:#62625c;font-size:.92rem}
  label{display:block;font-weight:600;margin-top:20px}
  input{box-sizing:border-box;width:100%;max-width:240px;padding:10px;margin:8px 0;border:1px solid #b5b0a5;border-radius:8px;font:1.2rem ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase}
  input:focus-visible{outline:3px solid #b98432;outline-offset:2px}#googleButton{margin-top:16px}#status{min-height:1.5em;margin-top:16px}
</style>
<script src="https://accounts.google.com/gsi/client" defer nonce="${nonce}"></script>
<script nonce="${nonce}" defer>
const $ = (id) => document.getElementById(id);
const status = (message) => { $('status').textContent = message; };
window.addEventListener('load', () => {
  if (!window.google?.accounts?.id) { status('Google sign-in did not load. Reload this page.'); return; }
  google.accounts.id.initialize({ client_id: ${JSON.stringify(env.GOOGLE_CLIENT_ID).replace(/</g, '\\u003c')}, callback: async ({ credential }) => {
    const code = $('code').value;
    if (code.replace(/[^a-z]/gi, '').length !== 8) { status('Enter the 8-letter code first, then sign in.'); return; }
    status('Connecting…');
    try {
      const response = await fetch('/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential, code }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { status(data.error || 'Could not connect. Try again.'); return; }
      $('form').hidden = true;
      status(data.name + ' is connected. Email ' + data.agentEmail + ' to give it work. You can close this page.');
    } catch { status('Could not connect. Check your connection and try again.'); }
  } });
  google.accounts.id.renderButton($('googleButton'), { theme: 'outline', size: 'large', text: 'continue_with' });
});
</script></head><body><main>
${link ? `<h1>Connect “${escapeHtml(link.name)}” to TagMails</h1>
<div id="form">
<p>Check that <code>tagmails pair</code> on that computer shows <strong>${displayCode(link.code)}</strong>, then continue with the Google account whose emails it should run.</p>
<input id="code" type="hidden" value="${displayCode(link.code)}">` : `<h1>Connect a computer to TagMails</h1>
<div id="form">
${askedFor ? '<p>That link has expired or was already used. Run <code>tagmails pair</code> again for a new one, or enter its code here.</p>' : ''}
<p>Enter the code that <code>tagmails pair</code> shows on the computer, then continue with the Google account whose emails it should run.</p>
<label for="code">Code</label><input id="code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="9" placeholder="BCDF-GHJK">`}
<p class="muted">Only connect a computer you are setting up yourself: whoever controls it will run your TagMails emails.</p>
<div id="googleButton"></div></div>
<p id="status" role="status"></p>
</main></body></html>`;
  return new Response(html, { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}' https://accounts.google.com; style-src 'nonce-${nonce}' https://accounts.google.com; img-src https: data:; frame-src https://accounts.google.com; connect-src 'self' https://accounts.google.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  } });
}

export async function deleteExpiredDeviceLinks(env) {
  await env.DB.prepare("DELETE FROM device_links WHERE expires_at < datetime('now', '-1 day')").bind().run();
}

export async function handleDeviceLink(request, env, { verifyIdentity = verifyGoogleCredential, sendEmail } = {}) {
  const { pathname } = new URL(request.url);
  if (pathname === '/skill.md') {
    return request.method === 'GET' ? new Response(setupSkill(env, request), { headers: {
      'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' } }) : null;
  }
  if (pathname !== '/connect' && pathname !== '/api/device/link') return null;
  if (!env.DB) throw new Error('Account database is not configured');
  if (pathname === '/api/device/link') {
    if (request.method === 'POST') return startLink(request, env);
    if (request.method === 'GET') return linkStatus(request, env);
    return new Response('Not found', { status: 404 });
  }
  if (!googleSignInConfigured(env)) return new Response('Google sign-in is not configured on this relay.', { status: 503 });
  if (request.method === 'GET') {
    const asked = new URL(request.url).searchParams.get('code');
    return connectPage(env, asked ? await pendingLink(env, asked) : null, Boolean(asked));
  }
  if (request.method === 'POST') return approve(request, env, verifyIdentity, sendEmail);
  return new Response('Not found', { status: 404 });
}

