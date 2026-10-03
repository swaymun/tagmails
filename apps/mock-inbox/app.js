const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const runtimeLabel = (runtime) => runtime === 'claude-cli-readonly' ? 'local Claude read-only'
  : runtime === 'codex-app-server-write' ? 'local Codex workspace write' : 'local Codex read-only';

let data;
let currentThread = null;
let currentFolder = 'Inbox';
let currentCategory = 'Primary';
let currentFixture = null;
let composeOpener = null;
let labOpener = null;
const readThreads = new Set();
const starredThreads = new Set();
let toastTimer;

const scenarios = {
  catchup: { subject: 'What did we decide for the beta?', body: 'Catch me up on the decisions in our launch thread and tell me what still needs an owner.' },
  incident: { subject: 'Screenshot missing from the task trace', body: 'A user reports that an attached screenshot disappears from the task trace. Find the cause and prepare a draft fix.' },
  metrics: { subject: 'How did the pilot go this week?', body: 'Pull the weekly task numbers and explain what needs attention.' },
  callprep: { subject: 'Prep me for the partner call', body: 'I am meeting a prospective pilot team. What should I know about the email workflow and open decisions?' },
  approval: { subject: 'Publish the launch site', body: 'Please publish the launch site when the draft is ready. Ask me before any external action.' },
  failure: { subject: 'Check this stopped run', body: 'Please inspect this fixture. [simulate:fail]' },
  cc: { subject: 'Review this plan together', body: 'Can you summarize the open questions and let my teammate continue this thread once they have permission?', cc: 'teammate@gmail.com' },
};

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.hidden = true; }, 4400);
}

async function api(path, body) {
  const response = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'The local lab could not complete that action');
  return result;
}

async function refresh() {
  const response = await fetch('/api/state', { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not load the local inbox');
  data = await response.json();
  render();
}

function timeLabel(iso) {
  const date = new Date(iso);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function matchingThreads() {
  const search = $('#search').value.trim().toLowerCase();
  return data.threads.filter((thread) => {
    if (currentCategory !== 'Primary' && currentFolder === 'Inbox') return false;
    if (currentFolder === 'Starred' && !starredThreads.has(thread.id)) return false;
    if (['Snoozed', 'Drafts', 'Categories'].includes(currentFolder)) return false;
    if (currentFolder === 'Sent' && !thread.messages.some((message) => message.direction === 'outbound')) return false;
    if (search && ![thread.subject, ...thread.messages.map((message) => `${message.from} ${message.text}`)].join(' ').toLowerCase().includes(search)) return false;
    return true;
  });
}

function renderInbox() {
  const threads = matchingThreads();
  $('#inboxCount').textContent = data.threads.length;
  $('#mailRange').textContent = `${threads.length ? 1 : 0}–${threads.length} of ${threads.length}`;
  $('#threadList').innerHTML = threads.map((thread) => {
    const last = thread.messages.at(-1);
    const people = [...new Set(thread.messages.map((message) => message.from === data.owner ? 'me' : message.from === data.agent ? 'Agent' : message.from.split('@')[0]))].join(', ');
    const snippet = (last.direction === 'outbound' ? last.text.split('\n').filter(Boolean).slice(1).join(' ') : last.text).replace(/\s+/g, ' ').slice(0, 150);
    const isRead = readThreads.has(thread.id);
    const isStarred = starredThreads.has(thread.id);
    return `<div class="mail-row${isRead ? ' read' : ''}" data-thread="${esc(thread.id)}" tabindex="0" aria-label="Open ${esc(thread.subject)}"><input type="checkbox" aria-label="Select ${esc(thread.subject)}"><button class="star-button${isStarred ? ' starred' : ''}" data-star="${esc(thread.id)}" aria-label="${isStarred ? 'Remove star from' : 'Star'} ${esc(thread.subject)}">${icon('star')}</button><span class="row-sender">${esc(people)}</span><span class="row-main"><span class="row-subject">${esc(thread.subject)}</span><span class="row-snippet"> — ${esc(snippet)}</span></span><time class="row-time" datetime="${esc(last.at)}">${esc(timeLabel(last.at))}</time></div>`;
  }).join('');
  $('#emptyState').hidden = threads.length > 0;
}

function renderThread(thread) {
  const jobs = data.jobs.filter((job) => job.threadId === thread.id);
  const lastJob = jobs.at(-1);
  $('#mailRange').textContent = '';
  $('#threadView').innerHTML = `<div class="thread-title"><h1 tabindex="-1">${esc(thread.subject)}</h1><span class="inbox-tag">Inbox</span></div>${thread.messages.map((message) => {
    const outgoing = message.direction === 'outbound';
    const label = message.from === data.owner ? 'me' : message.from === data.agent ? 'Agent' : message.from;
    const preview = outgoing
      ? `<iframe title="Rendered HTML email from ${esc(label)}" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" src="/preview?messageId=${encodeURIComponent(message.id)}"></iframe>`
      : esc(message.text);
    const attachments = (message.attachments ?? []).map((attachment) => {
      const href = `/api/attachment?messageId=${encodeURIComponent(message.id)}&attachmentId=${encodeURIComponent(attachment.id)}`;
      return `<a class="attachment-card" href="${href}" target="_blank" rel="noopener" download="${esc(attachment.name)}">${attachment.previewable ? `<img src="${href}" alt="Preview of ${esc(attachment.name)}" loading="lazy">` : `<span class="attachment-file">${icon('attachment')}</span>`}<span><strong>${esc(attachment.name)}</strong><small>${Math.max(1, Math.ceil(attachment.size / 1024))} KB</small></span></a>`;
    }).join('');
    const reactions = (message.reactions ?? []).map((reaction) => `<span class="reaction-chip" title="${esc(reaction.from)} reacted">${esc(reaction.emoji)} ${esc(reaction.from === data.owner ? 'you' : reaction.from)}</span>`).join('');
    const visibleRecipients = [message.to, ...message.cc].join(',').split(',').map((address) => address.trim()).filter(Boolean);
    const recipientCount = new Set([...visibleRecipients, ...(message.bcc ?? [])]).size;
    const canReact = outgoing && visibleRecipients.includes(data.owner) && recipientCount <= 20;
    const reactionButtons = canReact ? `<div class="reaction-picker" aria-label="Simulate Gmail emoji reaction"><span>React</span>${['👍', '❤️', '👀'].map((emoji) => `<button type="button" data-react="${emoji}" data-message="${encodeURIComponent(message.id)}" aria-label="React ${emoji} to this agent email">${emoji}</button>`).join('')}</div>` : '';
    return `<article class="thread-message"><div class="message-header"><span class="sender-avatar${outgoing ? ' agent' : ''}">${esc(label.slice(0, 1).toUpperCase())}</span><div class="sender-meta"><strong>${esc(label)}</strong><small>to ${esc(message.to)}${message.cc.length ? `, cc ${esc(message.cc.join(', '))}` : ''}${message.from === data.owner && message.bcc?.length ? `, bcc ${esc(message.bcc.join(', '))}` : ''}</small></div><time class="message-date" datetime="${esc(message.at)}">${esc(new Date(message.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</time></div><div class="message-body">${preview}</div>${attachments ? `<div class="attachment-list">${attachments}</div>` : ''}${reactions ? `<div class="reaction-list">${reactions}</div>` : ''}${reactionButtons}${outgoing ? `<div class="message-actions"><a href="/api/mime?messageId=${encodeURIComponent(message.id)}" target="_blank" rel="noopener">View raw MIME</a><span>HTML + plain text</span></div>` : ''}</article>`;
  }).join('')}<p class="thread-status">${lastJob ? `Latest task: <strong>${esc(lastJob.state.replaceAll('_', ' '))}</strong> · ${esc(lastJob.model.id ?? 'model unclear')}${lastJob.runtime ? ` · ${esc(runtimeLabel(lastJob.runtime))}` : ' · synthetic'}` : ''}</p><button class="reply-trigger" id="replyButton">${icon('reply')} Reply</button>`;
  $('#threadView').querySelectorAll('iframe').forEach((frame) => {
    frame.addEventListener('load', () => fitPreview(frame));
    if (frame.contentDocument?.readyState === 'complete') fitPreview(frame);
  });
}

function fitPreview(frame) {
  const doc = frame.contentDocument;
  if (!doc) return;
  frame.style.height = `${Math.max(180, doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0) + 8}px`;
}

window.addEventListener('resize', () => {
  $('#threadView').querySelectorAll('iframe').forEach(fitPreview);
});

function renderLab() {
  const queued = data.jobs.filter((job) => job.state === 'queued').length;
  const awaiting = data.jobs.filter((job) => job.state === 'needs_approval').length;
  $('#daemonStatus').textContent = `Mock daemon ${data.online ? 'connected' : 'offline'}`;
  $('#daemonIndicator').classList.toggle('online', data.online);
  $('#jobStatus').textContent = `${queued} queued${awaiting ? ` · ${awaiting} waiting for approval` : ''}`;
  $('#toggleDaemon').textContent = data.online ? 'Disconnect mock daemon' : 'Connect mock daemon';
  $('#processNext').disabled = !data.online || queued === 0;
  $('#queuedJobs').innerHTML = queued ? `<h2>Queued test jobs</h2><p>For an opt-in local Codex run, select one job ID in the terminal.</p>${data.jobs.filter((job) => job.state === 'queued').map((job) => `<div class="approval-item"><code>${esc(job.id)}</code> · ${esc(data.threads.find((item) => item.id === job.threadId)?.subject ?? 'Email task')}</div>`).join('')}` : '';
  const thread = data.threads.find((item) => item.id === currentThread);
  const guests = thread ? Object.entries(thread.guests) : [];
  $('#guestControls').innerHTML = guests.length ? `<h2>Participants on this thread</h2>${guests.map(([email, invite]) => `<div class="invite-item"><strong>${esc(email)}</strong><br>${invite.hidden ? 'Added by owner in Bcc' : 'Added by owner in To or Cc'} · ${(invite.authorized ?? (invite.verified && invite.approved)) ? 'Can reply to agent' : 'Access revoked'}<br>${(invite.authorized ?? (invite.verified && invite.approved)) ? `<button data-guest-action="revoke" data-email="${esc(email)}">Revoke access</button>` : ''}</div>`).join('')}` : '';
  $('#approvalControls').innerHTML = awaiting ? `<h2>Needs your decision</h2>${data.jobs.filter((job) => job.state === 'needs_approval').map((job) => `<div class="approval-item">${esc(data.threads.find((item) => item.id === job.threadId)?.subject ?? job.id)}<br>${job.runtime ? 'A local agent requested more access. Review the run and change local permissions before sending a new email.' : `<button data-approve="${esc(job.id)}">Approve simulated action</button>`}</div>`).join('')}` : '';
  $('#eventList').innerHTML = data.events.slice(0, 9).map((event) => `<li><time datetime="${esc(event.at)}">${esc(timeLabel(event.at))}</time>${esc(event.description)}</li>`).join('');
}

function render() {
  if (!data) return;
  const thread = data.threads.find((item) => item.id === currentThread);
  if (!thread) currentThread = null;
  $('#inboxView').hidden = Boolean(currentThread);
  $('#threadView').hidden = !currentThread;
  $('#inboxTools').hidden = Boolean(currentThread);
  $('#threadTools').hidden = !currentThread;
  document.querySelectorAll('.folder').forEach((button) => button.classList.toggle('active', button.dataset.folder === currentFolder));
  document.querySelectorAll('.category').forEach((button) => {
    const active = button.dataset.category === currentCategory;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  if (currentThread) renderThread(thread);
  else renderInbox();
  renderLab();
}

function openCompose({ reply = false, fixture = null } = {}) {
  composeOpener = document.activeElement;
  currentFixture = fixture;
  const thread = data?.threads.find((item) => item.id === currentThread);
  $('#composeTitle').textContent = reply ? `Reply: ${thread?.subject ?? ''}` : 'New Message';
  $('#fromField').value = data?.owner ?? 'owner@gmail.com';
  $('#toField').value = data?.agent ?? 'agent@wonder.test';
  $('#ccField').value = '';
  $('#bccField').value = '';
  $('#subjectField').value = reply ? `Re: ${thread.subject}` : '';
  $('#bodyField').value = '';
  $('#composeWindow').dataset.replyTo = reply ? thread.messages.at(-1).id : '';
  $('#composeWindow').hidden = false;
  $(reply || fixture ? '#bodyField' : '#subjectField').focus();
}

function closeCompose() {
  $('#composeWindow').hidden = true;
  currentFixture = null;
  (composeOpener?.getClientRects().length ? composeOpener : $('#composeButton')).focus();
}
function openLab() {
  labOpener = document.activeElement;
  $('#labDrawer').hidden = false;
  $('#closeLab').focus();
}
function closeLab({ restoreFocus = true } = {}) {
  $('#labDrawer').hidden = true;
  if (restoreFocus) (labOpener?.getClientRects().length ? labOpener : $('#labButton')).focus();
}
function openThread(id) {
  currentThread = id;
  readThreads.add(id);
  render();
  $('#threadView h1').focus();
}

$('#composeButton').addEventListener('click', () => openCompose());
$('#closeCompose').addEventListener('click', closeCompose);
$('#backButton').addEventListener('click', () => {
  const previous = currentThread;
  currentThread = null;
  render();
  (document.querySelector(`[data-thread="${CSS.escape(previous)}"]`) ?? $('#composeButton')).focus();
});
$('#refreshButton').addEventListener('click', () => refresh().catch((error) => toast(error.message)));
$('#search').addEventListener('input', () => { if (!currentThread) renderInbox(); });
$('#menuButton').addEventListener('click', () => document.body.classList.toggle('nav-open'));
$('#settingsButton').addEventListener('click', openLab);
$('#labButton').addEventListener('click', openLab);
$('#stripLabButton').addEventListener('click', openLab);
$('#closeLab').addEventListener('click', closeLab);

$('#threadList').addEventListener('click', (event) => {
  const star = event.target.closest('[data-star]');
  if (star) {
    const id = star.dataset.star;
    starredThreads.has(id) ? starredThreads.delete(id) : starredThreads.add(id);
    renderInbox();
    return;
  }
  if (event.target.matches('input[type="checkbox"]')) return;
  const row = event.target.closest('[data-thread]');
  if (row) openThread(row.dataset.thread);
});
$('#threadList').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target.matches('[data-thread]')) {
    openThread(event.target.dataset.thread);
  }
});
$('#threadView').addEventListener('click', async (event) => {
  if (event.target.closest('#replyButton')) { openCompose({ reply: true }); return; }
  const button = event.target.closest('[data-react]');
  if (!button) return;
  try {
    const result = await api('/api/react', { from: data.owner, targetId: decodeURIComponent(button.dataset.message), emoji: button.dataset.react });
    await refresh();
    toast(result.accepted ? 'Synthetic Gmail reaction recorded; no new task queued' : result.reason);
  } catch (error) { toast(error.message); }
});

document.querySelectorAll('.folder').forEach((button) => button.addEventListener('click', () => {
  currentFolder = button.dataset.folder;
  currentThread = null;
  render();
}));
document.querySelectorAll('.category').forEach((button) => button.addEventListener('click', () => {
  currentCategory = button.dataset.category;
  currentThread = null;
  render();
}));
$('.category-tabs').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...document.querySelectorAll('.category')];
  const index = tabs.indexOf(document.activeElement);
  if (index < 0) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].click();
  tabs[next].focus();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!$('#composeWindow').hidden) closeCompose();
  else if (!$('#labDrawer').hidden) closeLab();
});

$('#composeForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await api('/api/send', {
      from: $('#fromField').value, to: $('#toField').value, cc: $('#ccField').value, bcc: $('#bccField').value, subject: $('#subjectField').value,
      body: $('#bodyField').value, replyTo: $('#composeWindow').dataset.replyTo || null, fixture: currentFixture,
    });
    if (!result.accepted) { toast(result.reason); return; }
    closeCompose();
    currentThread = result.threadId;
    readThreads.add(currentThread);
    await refresh();
    $('#threadView h1').focus();
    toast(result.duplicate ? 'Duplicate email ignored' : 'Synthetic email queued');
  } catch (error) { toast(error.message); }
});

$('#toggleDaemon').addEventListener('click', async () => {
  try { await api('/api/daemon', { online: !data.online }); await refresh(); }
  catch (error) { toast(error.message); }
});
$('#processNext').addEventListener('click', async () => {
  try { const result = await api('/api/process', {}); await refresh(); toast(result.processed ? `Synthetic task ${result.state.replaceAll('_', ' ')}` : result.reason); }
  catch (error) { toast(error.message); }
});
$('.scenario-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-scenario]');
  if (!button) return;
  const kind = button.dataset.scenario;
  const scenario = scenarios[kind];
  openCompose({ fixture: kind });
  $('#subjectField').value = scenario.subject;
  $('#bodyField').value = scenario.body;
  $('#ccField').value = scenario.cc ?? '';
  closeLab({ restoreFocus: false });
  $('#bodyField').focus();
});
$('#guestControls').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-guest-action]');
  if (!button) return;
  try { await api('/api/guest', { threadId: currentThread, email: button.dataset.email, action: button.dataset.guestAction }); await refresh(); toast('Synthetic guest permission updated'); }
  catch (error) { toast(error.message); }
});
$('#approvalControls').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-approve]');
  if (!button) return;
  try { await api('/api/approve', { jobId: button.dataset.approve }); await refresh(); toast('Approval recorded; process the queued task'); }
  catch (error) { toast(error.message); }
});
$('#resetButton').addEventListener('click', async () => {
  if (!window.confirm('Reset this synthetic inbox and discard its local test messages?')) return;
  try { await api('/api/reset', {}); currentThread = null; readThreads.clear(); starredThreads.clear(); await refresh(); toast('Synthetic inbox reset'); }
  catch (error) { toast(error.message); }
});

async function importEmail(source) {
  try {
    const response = await fetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'message/rfc822' }, body: source });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Could not import the email');
    if (!result.accepted) { toast(result.reason); return; }
    $('#emlFile').value = '';
    closeLab({ restoreFocus: false });
    currentThread = result.threadId;
    readThreads.add(currentThread);
    await refresh();
    $('#threadView h1').focus();
    toast(result.duplicate ? 'Duplicate email ignored' : 'Synthetic .eml imported and queued');
  } catch (error) { toast(error.message); }
}
$('#importForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = $('#emlFile').files[0];
  if (!file) { toast('Choose an .eml file first'); return; }
  await importEmail(file);
});
$('#importSample').addEventListener('click', async () => {
  try {
    const response = await fetch('/samples/image-email.eml');
    if (!response.ok) throw new Error('Could not load the sample email');
    await importEmail(await response.blob());
  } catch (error) { toast(error.message); }
});

refresh().catch((error) => toast(error.message));
