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
  input,select{box-sizing:border-box;width:100%;max-width:100%;padding:10px;margin:8px 0;border:1px solid #b5b0a5;border-radius:8px;font:inherit}input:focus-visible,select:focus-visible{outline:3px solid #b98432;outline-offset:2px}
  code,pre{background:#f0eee8;border-radius:6px;padding:3px 6px;overflow-wrap:anywhere}
  pre{white-space:pre-wrap;padding:12px}.device{border-top:1px solid #e7e2d8;padding:12px 0;display:flex;justify-content:space-between;gap:12px;align-items:center}
  .thread{border-top:1px solid #e7e2d8;padding:16px 0}.thread h3{font-size:1rem;margin:0 0 4px;overflow-wrap:anywhere}
  .thread label{display:block;margin-top:12px}.thread .device{padding:8px 0}.thread .device span{overflow-wrap:anywhere}
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
        try {
          await api('/api/account/devices/' + device.id + '/revoke', { method: 'POST' });
          await devices(); await threads();
          status('Device revoked. Unfinished tasks on its threads stopped. Any reserved test credits were released. Start a new email thread for another Mac.');
        }
        catch (error) { status(error.message); }
      });
      row.append(button);
    }
    list.append(row);
  }
}
async function threads() {
  const data = await api('/api/account/threads');
  const list = $('threads'); list.replaceChildren();
  if (!data.threads.length) { list.textContent = 'No email threads yet.'; return; }
  for (const thread of data.threads) {
    const section = document.createElement('div'); section.className = 'thread';
    const title = document.createElement('h3'); title.textContent = thread.subject;
    section.append(title);
    if (thread.device) {
      const placement = document.createElement('p'); placement.className = 'muted';
      placement.textContent = thread.device.revokedAt
        ? 'This thread used ' + thread.device.name + ', which is revoked. Start a new email thread to use another Mac; its local agent memory cannot move automatically.'
        : 'Agent session on ' + thread.device.name + '. Follow-up turns stay on this Mac.';
      section.append(placement);
    }
    for (const person of thread.participants) {
      const row = document.createElement('div'); row.className = 'device';
      const name = document.createElement('span');
      name.textContent = person.email + (person.revokedAt ? ' · revoked' : ' · can reply');
      row.append(name);
      if (!person.revokedAt) {
        const revoke = document.createElement('button'); revoke.className = 'secondary'; revoke.textContent = 'Revoke';
        revoke.setAttribute('aria-label', 'Revoke ' + person.email + ' from ' + thread.subject);
        revoke.addEventListener('click', async () => {
          try {
            await api('/api/account/threads/' + thread.id + '/revoke', { method: 'POST',
              headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: person.email }) });
            await threads(); status('Participant access revoked.');
          } catch (error) { status(error.message); }
        });
        row.append(revoke);
      }
      section.append(row);
    }
    const label = document.createElement('label'); label.textContent = 'Grant reply access to an email address';
    const input = document.createElement('input'); input.type = 'email'; input.placeholder = 'teammate@gmail.com'; input.autocomplete = 'off';
    label.append(input); section.append(label);
    const invite = document.createElement('button'); invite.textContent = 'Grant access';
    invite.addEventListener('click', async () => {
      invite.disabled = true;
      try {
        await api('/api/account/threads/' + thread.id + '/invite', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: input.value }) });
        await threads(); status('Reply access granted. No invitation email was sent.');
      } catch (error) { status(error.message); invite.disabled = false; }
    });
    section.append(invite); list.append(section);
  }
}
async function billing() {
  const data = await api('/api/billing');
  $('balance').textContent = '$' + (data.balanceCents / 100).toFixed(2) + ' in test credits' +
    (data.waitingEmails ? ' · ' + data.waitingEmails + ' email' + (data.waitingEmails === 1 ? '' : 's') + ' waiting for credits' : '');
  $('topup').hidden = !data.checkoutEnabled;
}
let googleReady = false;
let savedDefaultModel = 'gpt-6.1-sol';
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
  savedDefaultModel = account.defaultModel;
  $('defaultModel').value = savedDefaultModel;
  $('delivery').textContent = account.deliveryReady
    ? 'Mail delivery is configured for this address.'
    : 'This address can receive development test mail. tagmails.com mail awaits domain verification.';
  const next = new URLSearchParams(location.search).get('next');
  if (next?.startsWith('/runs/') && /^[0-9a-f-]{36}$/i.test(next.slice(6))) { location.assign(next); return; }
  try { await devices(); }
  catch { $('devices').textContent = 'Devices could not be loaded. Reload to try again.'; }
  try { await threads(); }
  catch { $('threads').textContent = 'Threads could not be loaded. Reload to try again.'; }
  try { await billing(); }
  catch { $('balance').textContent = 'Test balance is unavailable. Reload to try again.'; }
  status(new URLSearchParams(location.search).get('topup') === 'returned'
    ? 'Stripe test checkout returned. Credits appear here only after the paid webhook is verified.' : '');
}

let pairCode = '';
function pairCommand() {
  return 'mkdir -p "$HOME/.config/tagmails" && TAGMAILS_RELAY_URL=' + location.origin +
    ' TAGMAILS_DEVICE_TOKEN_FILE="$HOME/.config/tagmails/device-token" cargo run -p tagmails-daemon -- --pair ' + pairCode;
}
function shellQuote(value) {
  const quote = String.fromCharCode(39);
  return quote + value.split(quote).join(quote + String.fromCharCode(92) + quote + quote) + quote;
}
function installCommand() {
  const workspace = $('workspace').value.trim();
  const access = $('workspaceAccess').value;
  if (!workspace.startsWith('/') || workspace.length > 1024 ||
      workspace.includes(String.fromCharCode(10)) || workspace.includes(String.fromCharCode(13))) {
    throw new Error('Enter an absolute workspace path on your Mac.');
  }
  if (access !== 'read' && access !== 'write') throw new Error('Choose read-only or edit access.');
  return 'cargo build --release -p tagmails-daemon && node scripts/install-macos-launchagent.mjs' +
    ' --relay ' + shellQuote(location.origin) + ' --workspace ' + shellQuote(workspace) +
    ' --workspace-access ' + access +
    ' --token-file "$HOME/.config/tagmails/device-token"';
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
  const updateInstall = () => {
    try { $('installCommand').textContent = installCommand(); status(''); }
    catch { $('installCommand').textContent = 'Enter an absolute workspace path to prepare the command.'; }
  };
  $('workspace').addEventListener('input', updateInstall);
  $('workspaceAccess').addEventListener('change', updateInstall);
  $('copyInstall').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(installCommand()); status('Start command copied. Run it from your TagMails checkout after pairing.'); }
    catch (error) { status(error.message === 'Enter an absolute workspace path on your Mac.' ? error.message : 'Copy failed. Select the command above to copy it.'); }
  });
  $('topup').addEventListener('click', async () => {
    $('topup').disabled = true;
    try {
      const data = await api('/api/billing/checkout', { method: 'POST' });
      location.assign(data.checkoutUrl);
    } catch (error) { status(error.message); $('topup').disabled = false; }
  });
  $('refreshBalance').addEventListener('click', async () => {
    try { await billing(); status('Test balance refreshed.'); }
    catch { status('Test balance is unavailable. Reload to try again.'); }
  });
  $('refreshThreads').addEventListener('click', async () => {
    try { await threads(); status('Threads refreshed.'); }
    catch { status('Threads could not be loaded. Reload to try again.'); }
  });
  $('saveDefaultModel').addEventListener('click', async () => {
    $('saveDefaultModel').disabled = true;
    try {
      await api('/api/account/default-model', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: $('defaultModel').value }) });
      savedDefaultModel = $('defaultModel').value;
      status('Default model saved for new task emails.');
    } catch (error) { $('defaultModel').value = savedDefaultModel; status(error.message); }
    finally { $('saveDefaultModel').disabled = false; }
  });
  $('signOut').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); await refresh(); }
    catch (error) { status(error.message); }
  });
  refresh();
});
</script></head><body><main>
<p class="eyebrow">tagmails. / account</p><h1>Your agent address.</h1>
<p class="muted">Private owner-only pilot. Sign in with the configured Gmail account, then pair your Mac. Google sign-in does not grant mailbox access. Development mail is visible in the Resend team dashboard.</p>
<p id="status" role="status" aria-live="polite"></p>
<section id="signedOut" class="card" hidden><h2>Sign in</h2><p>Use the owner Gmail address for this private pilot. Customer signup is closed.</p><div id="googleButton"></div></section>
<div id="signedIn" hidden>
  <section class="card"><h2>Account</h2><p>Verified sender<br><span id="ownerEmail" class="address"></span></p>
    <p>Agent address<br><span id="agentEmail" class="address"></span></p><p id="delivery" class="muted"></p>
    <label for="defaultModel">Default model for new task emails</label>
    <select id="defaultModel"><option value="gpt-6.1-sol">Codex Sol · medium</option>
      <option value="claude-sonnet-5-5" disabled>Claude Code · on hold</option></select>
    <button id="saveDefaultModel" class="secondary">Save default model</button>
    <p class="muted">This private Mac pilot uses GPT-6 Sol while GPT-6.1 Sol is unavailable with its ChatGPT account. No model line is required. Ask naturally, such as “use Luna Medium for this” or “use Codex Fast,” to choose a model, effort, or available speed. When effort is unclear, TagMails uses Medium. Unsupported runtime choices receive a no-charge notice. Claude subscription requests are paused in this pilot.</p>
    <button id="signOut" class="secondary">Sign out</button></section>
  <section class="card"><h2>Pair a Mac</h2><p>Create a one-time code, then run the setup command in your TagMails checkout. The device token stays in a file on your Mac.</p>
    <button id="pair">Create pairing code</button><p><code id="pairCode"></code></p><pre id="pairCommand"></pre>
    <button id="copyPair" class="secondary" hidden>Copy pairing command</button>
    <p class="muted">The command saves a device token under your home directory. It will not overwrite an existing token. Pairing does not start the agent or send email.</p></section>
  <section class="card"><h2>Start on your Mac</h2><p>Choose one folder and its file access, then start the agent at login. Read-only is the default.</p>
    <label for="workspace">Absolute workspace path</label><br><input id="workspace" type="text" autocomplete="off" spellcheck="false" placeholder="/Users/you/Projects/example">
    <label for="workspaceAccess">File access</label><select id="workspaceAccess"><option value="read">Read only</option><option value="write">Allow edits in this folder</option></select>
    <p class="muted">If you allow edits, people you authorize on a thread can also request changes inside this folder.</p>
    <pre id="installCommand">Enter an absolute workspace path to prepare the command.</pre>
    <button id="copyInstall" class="secondary">Copy start command</button>
    <p class="muted">The installer checks the path and token, then registers a macOS LaunchAgent. It refuses to overwrite an existing TagMails agent. The checkout and local CLI tools must remain available on this Mac.</p></section>
  <section class="card"><h2>Devices</h2><div id="devices"></div></section>
  <section class="card"><h2>Shared threads</h2><p class="muted">Only you can grant or revoke reply access. To include someone hidden in Bcc, grant their address here after you send the thread. This does not send them an invitation or reveal them in a reply.</p><button id="refreshThreads" class="secondary">Refresh threads</button><div id="threads"></div></section>
  <section class="card"><h2>Test credits</h2><p id="balance">Loading balance…</p>
    <p class="muted">In test mode, each accepted task email reserves a provisional $0.05 and settles when its reply is accepted for delivery. Real payments and final pricing are not enabled.</p>
    <button id="topup" hidden>Add $10 in Stripe test mode</button> <button id="refreshBalance" class="secondary">Refresh balance</button></section>
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
  const transcript = run.result?.transcript?.version === 1 && Array.isArray(run.result.transcript.events)
    ? run.result.transcript : null;
  const usage = run.result?.usage;
  const hasUsage = usage && ['inputTokens', 'cachedInputTokens', 'cacheCreationInputTokens', 'outputTokens', 'reasoningOutputTokens']
    .every((key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0);
  const listCost = run.result?.reportedListCostUsd;
  const list = (items) => `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(run.subject)} · TagMails run</title><style nonce="${nonce}">
:root{font:16px/1.55 system-ui,sans-serif;color:#242424;background:#f7f4ed}body{margin:0}main{max-width:720px;margin:7vh auto;padding:0 24px 80px}
a{color:#255d53}a:focus-visible{outline:3px solid #b98432;outline-offset:3px}.eyebrow{letter-spacing:.12em;text-transform:uppercase;font-size:.72rem;font-weight:700;color:#57776f}
h1{font-size:clamp(2rem,6vw,3.25rem);line-height:1.1;margin:.35em 0}h2{font-size:1.05rem;margin:28px 0 8px}p{margin:8px 0 16px}.card{background:#fff;border:1px solid #ddd9cf;border-radius:14px;padding:24px;margin:24px 0}
.status{display:inline-block;background:#e5eee8;color:#225440;border-radius:30px;padding:4px 11px;font-size:.8rem;font-weight:700}.muted{color:#62625c}.meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 24px;margin-top:24px;font-size:.9rem}
.meta strong{display:block;color:#242424}.meta span{overflow-wrap:anywhere}li{margin:6px 0}.event{border-top:1px solid #e5e2db;padding:14px 0}.event:first-child{border-top:0}.event strong{display:block;font-size:.8rem;color:#526960;text-transform:uppercase;letter-spacing:.07em}.event p{white-space:pre-wrap;overflow-wrap:anywhere;margin:5px 0 0}.event.tool{color:#555;background:#f7f7f4;padding:12px;border-radius:8px;margin:8px 0}@media(max-width:520px){.meta{grid-template-columns:1fr}}
</style></head><body><main><p class="eyebrow">tagmails. / run receipt</p><a href="/account">Account</a>
<h1>${escapeHtml(run.subject)}</h1><span class="status">${title}</span>
<section class="card"><h2>Outcome</h2><p>${escapeHtml(run.result?.summary ?? (run.state === 'failed'
    ? 'This run stopped before an agent result was saved. If it may have edited files, inspect the workspace.'
    : 'The agent has not submitted a result yet.'))}</p>
${run.delivery_state === 'uncertain' ? '<p class="muted">Email delivery needs review. This reply will not be sent again automatically.</p>' : ''}
${run.delivery_state === 'accepted' ? '<p class="muted">The mail provider accepted the reply. The relay is waiting for its Message-ID before finishing this email thread. Later replies in this thread will wait; inbox delivery is not confirmed.</p>' : ''}
${run.delivery_state === 'blocked' ? '<p class="muted">This reply was stopped before sending. It needs review and will not be retried automatically.</p>' : ''}
${run.delivery_state === 'sent' ? '<p class="muted">Resend accepted the reply. Inbox delivery is reported separately below when available.</p>' : ''}
${run.deliveryRecipients?.length ? `<h2>Recipient delivery</h2>${list(run.deliveryRecipients.map((item) => `${item.recipient_email}: ${item.status}`))}<p class="muted">Only reported recipients are listed. Other recipients may still be pending or unconfirmed.</p>` : ''}
${details.length ? `<h2>What happened</h2>${list(details)}` : ''}
${checks.length ? `<h2>Checks and limits</h2>${list(checks)}` : ''}
${hasUsage ? `<h2>Model usage reported by the local CLI</h2><p>${escapeHtml(usage.inputTokens)} input tokens (${escapeHtml(usage.cachedInputTokens)} cached, ${escapeHtml(usage.cacheCreationInputTokens)} cache creation); ${escapeHtml(usage.outputTokens)} output tokens (${escapeHtml(usage.reasoningOutputTokens)} reasoning).</p>` : ''}
${typeof listCost === 'number' && Number.isFinite(listCost) && listCost >= 0 ? `<p>List-equivalent model cost reported by the CLI: $${escapeHtml(listCost.toFixed(6))}. This is not a TagMails charge.</p>` : ''}
<div class="meta"><span><strong>Sender</strong>${escapeHtml(run.sender_email)}</span><span><strong>Received</strong>${escapeHtml(run.created_at)} UTC</span>
${run.selectedModel ? `<span><strong>Model route</strong>${escapeHtml(run.selectedModel)}</span>` : ''}
<span><strong>Attempts</strong>${escapeHtml(run.attempts)}</span><span><strong>Provider send</strong>${escapeHtml(run.delivery_state ?? 'Not queued')}</span></div></section>
${run.artifacts?.length ? `<section class="card"><h2>Files</h2><ul>${run.artifacts.map((file) => `<li><a href="/runs/${escapeHtml(run.id)}/artifacts/${escapeHtml(file.id)}">${escapeHtml(file.name)}</a> (${escapeHtml((file.byte_size / 1_000_000).toFixed(1))} MB)</li>`).join('')}</ul><p class="muted">Files expire seven days after upload.</p></section>` : ''}
<section class="card"><h2>Run transcript</h2>
${transcript ? transcript.events.map((event) => `<div class="event ${event.kind === 'tool' ? 'tool' : ''}"><strong>${escapeHtml(event.kind === 'request' ? 'Email request' : event.kind === 'tool' ? 'Tool step' : event.kind === 'reasoning' ? 'Reasoning summary' : event.phase === 'commentary' ? 'Agent update' : event.phase === 'final_answer' ? 'Agent answer' : 'Agent')}</strong><p>${escapeHtml(event.text)}</p></div>`).join('') : '<p class="muted">A transcript was not recorded for this run.</p>'}
${transcript?.truncated ? '<p class="muted">Long content and later steps were shortened to fit this receipt.</p>' : ''}
<p class="muted">Model-provided reasoning summaries may appear. Private reasoning, setup prompts, and raw tool output are excluded.</p></section>
</main></body></html>`;
  return new Response(html, { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  } });
}
