const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;

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
    return `<article class="thread-message"><div class="message-header"><span class="sender-avatar${outgoing ? ' agent' : ''}">${esc(label.slice(0, 1).toUpperCase())}</span><div class="sender-meta"><strong>${esc(label)}</strong><small>to ${esc(message.to)}${message.cc.length ? `, cc ${esc(message.cc.join(', '))}` : ''}</small></div><time class="message-date" datetime="${esc(message.at)}">${esc(new Date(message.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</time></div><div class="message-body">${preview}</div>${outgoing ? `<div class="message-actions"><a href="/api/mime?messageId=${encodeURIComponent(message.id)}" target="_blank" rel="noopener">View raw MIME</a><span>HTML + plain text</span></div>` : ''}</article>`;
  }).join('')}<p class="thread-status">${lastJob ? `Latest task: <strong>${esc(lastJob.state.replaceAll('_', ' '))}</strong> · ${esc(lastJob.model.id ?? 'model unclear')}` : ''}</p><button class="reply-trigger" id="replyButton">${icon('reply')} Reply</button>`;
  $('#threadView').querySelectorAll('iframe').forEach((frame) => {
    const fit = () => {
      const doc = frame.contentDocument;
      if (!doc) return;
      frame.style.height = `${Math.min(1800, Math.max(180, doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0) + 8)}px`;
    };
    frame.addEventListener('load', fit);
    if (frame.contentDocument?.readyState === 'complete') fit();
  });
}

function renderLab() {
  const queued = data.jobs.filter((job) => job.state === 'queued').length;
  const awaiting = data.jobs.filter((job) => job.state === 'needs_approval').length;
  $('#daemonStatus').textContent = `Mock daemon ${data.online ? 'connected' : 'offline'}`;
  $('#daemonIndicator').classList.toggle('online', data.online);
  $('#jobStatus').textContent = `${queued} queued${awaiting ? ` · ${awaiting} waiting for approval` : ''}`;
  $('#toggleDaemon').textContent = data.online ? 'Disconnect mock daemon' : 'Connect mock daemon';
  $('#processNext').disabled = !data.online || queued === 0;
  const thread = data.threads.find((item) => item.id === currentThread);
  const guests = thread ? Object.entries(thread.guests) : [];
  $('#guestControls').innerHTML = guests.length ? `<h2>Guests on this thread</h2>${guests.map(([email, invite]) => `<div class="invite-item"><strong>${esc(email)}</strong><br>${invite.verified ? 'Address verified' : 'Address unverified'} · ${invite.approved ? 'Owner approved' : 'Owner approval pending'}<br>${!invite.verified ? `<button data-guest-action="verify" data-email="${esc(email)}">Simulate verification</button>` : ''}${!invite.approved ? `<button data-guest-action="approve" data-email="${esc(email)}">Approve access</button>` : ''}</div>`).join('')}` : '';
  $('#approvalControls').innerHTML = awaiting ? `<h2>Needs your decision</h2>${data.jobs.filter((job) => job.state === 'needs_approval').map((job) => `<div class="approval-item">${esc(data.threads.find((item) => item.id === job.threadId)?.subject ?? job.id)}<br><button data-approve="${esc(job.id)}">Approve simulated action</button></div>`).join('')}` : '';
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
  $('#ccField').value = '';
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
$('#threadView').addEventListener('click', (event) => { if (event.target.closest('#replyButton')) openCompose({ reply: true }); });

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
      from: $('#fromField').value, cc: $('#ccField').value, subject: $('#subjectField').value,
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

refresh().catch((error) => toast(error.message));
