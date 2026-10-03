import { randomBytes } from 'node:crypto';

export function accountPage() {
  const nonce = randomBytes(16).toString('base64');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Account · TagMails</title>
<style nonce="${nonce}">
  :root{font:16px/1.5 system-ui,sans-serif;color:#242424;background:#f7f4ed}
  body{margin:0}main{max-width:680px;margin:8vh auto;padding:0 24px 80px}
  a{color:#255d53}h1{font-size:clamp(2rem,7vw,3.4rem);line-height:1.05;margin:.3em 0}
  h2{font-size:1.2rem;margin:0 0 12px}.eyebrow{letter-spacing:.12em;text-transform:uppercase;font-size:.72rem;font-weight:700;color:#57776f}
  .card{background:#fff;border:1px solid #ddd9cf;border-radius:14px;padding:24px;margin:24px 0}
  .muted{color:#62625c}.address{font-weight:700;overflow-wrap:anywhere;font-size:1.12rem}
  button{border:0;background:#183c35;color:white;border-radius:9px;padding:11px 15px;font:inherit;cursor:pointer}
  button:hover{background:#28574d}button:disabled{opacity:.55;cursor:wait}
  button.secondary{background:#edeae2;color:#20362f}button:focus-visible,a:focus-visible{outline:3px solid #b98432;outline-offset:3px}
  code,pre{background:#f0eee8;border-radius:6px;padding:3px 6px;overflow-wrap:anywhere}
  pre{white-space:pre-wrap;padding:12px}.device{border-top:1px solid #e7e2d8;padding:12px 0;display:flex;justify-content:space-between;gap:12px;align-items:center}
  #status{min-height:1.5em}#signedIn[hidden],#signedOut[hidden]{display:none}
</style>
<script src="https://accounts.google.com/gsi/client" defer></script>
<script nonce="${nonce}" defer>
const $ = (id) => document.getElementById(id);
const status = (message) => { $('status').textContent = message; };
async function api(path, options) {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
async function devices() {
  const data = await api('/api/account/devices');
  const list = $('devices'); list.replaceChildren();
  if (!data.devices.length) { list.textContent = 'No Mac is paired yet.'; return; }
  for (const device of data.devices) {
    const row = document.createElement('div'); row.className = 'device';
    const name = document.createElement('span'); name.textContent = device.name + (device.revoked_at ? ' · revoked' : ' · paired');
    row.append(name);
    if (!device.revoked_at) {
      const button = document.createElement('button'); button.className = 'secondary'; button.textContent = 'Revoke';
      button.setAttribute('aria-label', 'Revoke ' + device.name);
      button.addEventListener('click', async () => {
        try { await api('/api/account/devices/' + device.id + '/revoke', { method: 'POST' }); await devices(); }
        catch (error) { status(error.message); }
      });
      row.append(button);
    }
    list.append(row);
  }
}
let googleReady = false;
async function showGoogle() {
  if (googleReady) return;
  const config = await api('/api/auth/config');
  if (!window.google?.accounts?.id) throw new Error('Google sign-in did not load. Reload this page.');
  google.accounts.id.initialize({ client_id: config.clientId, callback: async (response) => {
    try {
      await api('/api/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: response.credential }) });
      await refresh();
    } catch (error) { status(error.message); }
  }});
  google.accounts.id.renderButton($('googleButton'), { theme: 'outline', size: 'large', text: 'signin_with' });
  googleReady = true;
}
async function refresh() {
  let account;
  try {
    account = await api('/api/account/me');
  } catch (error) {
    if (error.message !== 'Sign in required') { status('Could not load your account. Reload to try again.'); return; }
    $('signedIn').hidden = true; $('signedOut').hidden = false;
    status('');
    await showGoogle().catch((loadError) => {
      $('googleButton').textContent = 'Account setup is unavailable on this relay. Reload after Google sign-in is configured.';
      status(loadError.message === 'Google sign-in is not configured'
        ? 'This relay needs a Google client ID and agent domain before sign-in can begin.'
        : loadError.message);
    });
    return;
  }
  $('signedOut').hidden = true; $('signedIn').hidden = false;
  $('ownerEmail').textContent = account.ownerEmail;
  $('agentEmail').textContent = account.agentEmail;
  $('delivery').textContent = account.deliveryReady
    ? 'Mail delivery is configured for this address.'
    : 'Address reserved. Email delivery is not connected yet.';
  const next = new URLSearchParams(location.search).get('next');
  if (next?.startsWith('/runs/') && /^[0-9a-f-]{36}$/i.test(next.slice(6))) { location.assign(next); return; }
  try { await devices(); status(''); }
  catch { $('devices').textContent = 'Devices could not be loaded. Reload to try again.'; status('Account loaded, but device status is unavailable.'); }
}

let pairCode = '';
function pairCommand() {
  return 'mkdir -p "$HOME/.config/tagmails" && TAGMAILS_RELAY_URL=' + location.origin +
    ' TAGMAILS_DEVICE_TOKEN_FILE="$HOME/.config/tagmails/device-token" cargo run -p tagmails-daemon -- --pair ' + pairCode;
}
document.addEventListener('DOMContentLoaded', () => {
  $('pair').addEventListener('click', async () => {
    $('pair').disabled = true;
    try {
      const { code } = await api('/api/account/pairing-code', { method: 'POST' });
      pairCode = code;
      $('pairCode').textContent = code;
      $('pairCommand').textContent = pairCommand();
      $('copyPair').hidden = false;
      status('This code expires in 10 minutes and can be used once.');
    } catch (error) { status(error.message); }
    finally { $('pair').disabled = false; }
  });
  $('copyPair').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(pairCommand()); status('Pairing command copied. Run it from your TagMails checkout.'); }
    catch { status('Copy failed. Select the command above to copy it.'); }
  });
  $('signOut').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); await refresh(); }
    catch (error) { status(error.message); }
  });
  refresh();
});
</script></head><body><main>
<p class="eyebrow">tagmails. / account</p><h1>Your agent address.</h1>
<p class="muted">Sign in with a personal Gmail account, then pair your Mac. Google sign-in does not grant mailbox access.</p>
<p id="status" role="status" aria-live="polite"></p>
<section id="signedOut" class="card" hidden><h2>Sign in</h2><p>Use the Gmail address you will send tasks from.</p><div id="googleButton"></div></section>
<div id="signedIn" hidden>
  <section class="card"><h2>Account</h2><p>Verified sender<br><span id="ownerEmail" class="address"></span></p>
    <p>Agent address<br><span id="agentEmail" class="address"></span></p><p id="delivery" class="muted"></p>
    <button id="signOut" class="secondary">Sign out</button></section>
  <section class="card"><h2>Pair a Mac</h2><p>Create a one-time code, then run the setup command in your TagMails checkout. The device token stays in a file on your Mac.</p>
    <button id="pair">Create pairing code</button><p><code id="pairCode"></code></p><pre id="pairCommand"></pre>
    <button id="copyPair" class="secondary" hidden>Copy pairing command</button>
    <p class="muted">The command saves a device token under your home directory. It will not overwrite an existing token. Pairing does not start the agent or send email.</p></section>
  <section class="card"><h2>Devices</h2><div id="devices"></div></section>
</div></main></body></html>`;
  return new Response(html, { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}' https://accounts.google.com; style-src 'nonce-${nonce}'; img-src https: data:; frame-src https://accounts.google.com; connect-src 'self' https://accounts.google.com; base-uri 'none'; form-action 'none'`,
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin',
  } });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

export function runReceiptPage(run) {
  const nonce = randomBytes(16).toString('base64');
  const title = ({ queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed' })[run.state] ?? 'Run';
  const details = Array.isArray(run.result?.details) ? run.result.details : [];
  const checks = Array.isArray(run.result?.checks) ? run.result.checks : [];
  const list = (items) => `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(run.subject)} · TagMails run</title><style nonce="${nonce}">
:root{font:16px/1.55 system-ui,sans-serif;color:#242424;background:#f7f4ed}body{margin:0}main{max-width:720px;margin:7vh auto;padding:0 24px 80px}
a{color:#255d53}a:focus-visible{outline:3px solid #b98432;outline-offset:3px}.eyebrow{letter-spacing:.12em;text-transform:uppercase;font-size:.72rem;font-weight:700;color:#57776f}
h1{font-size:clamp(2rem,6vw,3.25rem);line-height:1.1;margin:.35em 0}h2{font-size:1.05rem;margin:28px 0 8px}p{margin:8px 0 16px}.card{background:#fff;border:1px solid #ddd9cf;border-radius:14px;padding:24px;margin:24px 0}
.status{display:inline-block;background:#e5eee8;color:#225440;border-radius:30px;padding:4px 11px;font-size:.8rem;font-weight:700}.muted{color:#62625c}.meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 24px;margin-top:24px;font-size:.9rem}
.meta strong{display:block;color:#242424}.meta span{overflow-wrap:anywhere}li{margin:6px 0}@media(max-width:520px){.meta{grid-template-columns:1fr}}
</style></head><body><main><p class="eyebrow">tagmails. / run receipt</p><a href="/account">Account</a>
<h1>${escapeHtml(run.subject)}</h1><span class="status">${title}</span>
<section class="card"><h2>Outcome</h2><p>${escapeHtml(run.result?.summary ?? 'The agent has not submitted a result yet.')}</p>
${details.length ? `<h2>What happened</h2>${list(details)}` : ''}
${checks.length ? `<h2>Checks and limits</h2>${list(checks)}` : ''}
<div class="meta"><span><strong>Sender</strong>${escapeHtml(run.sender_email)}</span><span><strong>Received</strong>${escapeHtml(run.created_at)} UTC</span>
<span><strong>Attempts</strong>${escapeHtml(run.attempts)}</span><span><strong>Email delivery</strong>${escapeHtml(run.delivery_state ?? 'Not queued')}</span></div></section>
<p class="muted">This receipt shows the recorded outcome and delivery state. A step-by-step agent trace is not stored yet.</p>
</main></body></html>`;
  return new Response(html, { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  } });
}
