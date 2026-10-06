import { createHash, randomUUID } from 'node:crypto';
import { Resend } from 'resend';
import { addressParser } from 'postal-mime';
import { parseInbound, RELAY_INBOUND_LIMITS } from '../apps/mock-inbox/inbound.mjs';
import { knownAgentAddresses } from './agent-addresses.mjs';
import { testSenderFor } from './agent-username.mjs';
import { cloudflareMessageId, sendWithCloudflare } from './cloudflare-mail.mjs';
import { openText, sealText } from './storage-crypto.mjs';
import { renderResult } from '../apps/mock-inbox/mail.mjs';
import { ATTACHABLE_BYTES, releaseFailedPrimaryTestEmail, releaseTestEmail, settleTestEmail, testBillingEnabled, testWalletSnapshot } from './email-charges.mjs';
import { selectedModelStatus } from './model-route.mjs';
import { artifactForDownload, selectedRunArtifacts } from './run-artifacts.mjs';

// Gmail rejects whole messages (552 5.7.0) for archives and executables, so
// only documents, media and text ride along; anything else becomes a link.
const EMAIL_SAFE_FILE = /\.(pdf|txt|md|csv|tsv|json|html?|rtf|docx|xlsx|pptx|odt|ods|odp|png|jpe?g|gif|webp|heic|svg|mp3|m4a|wav|mp4|mov|ics)$/i;

const MESSAGE_ID = /^<[^<>\s]+@[^<>\s]+>$/;

class InvalidOutboxSource extends Error {}

function publicOrigin(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:' && url.port)) ||
        url.pathname !== '/' || url.search || url.hash || url.username || url.password) return null;
    return url.origin;
  } catch { return null; }
}

function sameRecipients(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const expected = [...right].sort();
  return [...left].sort().every((email, index) => email === expected[index]);
}

function matchesSentAudience(payload, event) {
  const cc = payload.cc ?? [];
  if (sameRecipients(payload.to, event.to) && sameRecipients(cc, event.cc)) return true;
  return event.to.length === 1 && event.cc.length === 0 &&
    [...payload.to, ...cc].includes(event.to[0]);
}

function providerMailbox(value) {
  const addresses = addressParser(String(value ?? ''));
  if (addresses.length !== 1 || !addresses[0].address) throw new Error('Invalid provider mailbox');
  return addresses[0].address.toLowerCase();
}

function providerRecipients(value) {
  return (Array.isArray(value) ? value : []).map(providerMailbox);
}

async function saveOutboundMessage(env, jobId, threadId, providerEmailId, messageId) {
  const account = await env.DB.prepare(`SELECT t.account_id, a.agent_email FROM jobs j
    JOIN threads t ON t.id = j.thread_id JOIN accounts a ON a.id = t.account_id
    WHERE j.id = ?`).bind(jobId).first();
  if (!account) throw new Error('Outbound job has no account');
  await env.DB.prepare(`INSERT INTO messages
    (id, account_id, thread_id, provider_email_id, message_id, direction, sender_email, object_key)
    VALUES (?, ?, ?, ?, ?, 'outbound', ?, ?)
    ON CONFLICT(account_id, provider_email_id) DO NOTHING`)
    .bind(randomUUID(), account.account_id, threadId, providerEmailId, messageId,
      account.agent_email, `outbound/${account.account_id}/${jobId}.json`).run();
  const saved = await env.DB.prepare('SELECT message_id FROM messages WHERE account_id = ? AND provider_email_id = ?')
    .bind(account.account_id, providerEmailId).first();
  if (saved?.message_id !== messageId) throw new Error('Outbound Message-ID conflicts with the provider record');
}

export async function reconcileSentEvent(env, event) {
  const row = await env.DB.prepare(`SELECT o.state, o.payload_json, o.provider_email_id, j.thread_id
    FROM outbox o JOIN jobs j ON j.id = o.job_id WHERE o.job_id = ?`)
    .bind(event.jobId).first();
  if (!row || !['sending', 'uncertain', 'accepted', 'sent'].includes(row.state)) return { accepted: false };
  let payload;
  try { payload = JSON.parse(row.payload_json); }
  catch { return { accepted: false }; }
  if (payload.tags?.some(({ name, value }) => name === 'tagmails_job' && value === event.jobId) !== true ||
      payload.from !== event.from || await openText(env, payload.subject) !== event.subject ||
      !matchesSentAudience(payload, event) || !MESSAGE_ID.test(event.messageId ?? '') ||
      (row.provider_email_id && row.provider_email_id !== event.providerEmailId)) return { accepted: false };
  if (row.state === 'sent') {
    const saved = await env.DB.prepare(`SELECT message_id FROM messages
      WHERE thread_id = ? AND provider_email_id = ? AND direction = 'outbound'`)
      .bind(row.thread_id, event.providerEmailId).first();
    return { accepted: saved?.message_id === event.messageId, duplicate: true };
  }
  const updated = await env.DB.prepare(`UPDATE outbox SET state = 'accepted', provider_email_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE job_id = ? AND state IN ('sending', 'uncertain', 'accepted')
      AND (provider_email_id IS NULL OR provider_email_id = ?) RETURNING job_id`)
    .bind(event.providerEmailId, event.jobId, event.providerEmailId).first();
  if (updated) await saveOutboundMessage(env, event.jobId, row.thread_id, event.providerEmailId, event.messageId);
  return { accepted: Boolean(updated), sentEvent: true };
}

export async function recordDeliveryOutcome(env, event) {
  if (!['delivered', 'delayed', 'bounced', 'failed', 'suppressed'].includes(event.status)) {
    return { accepted: false };
  }
  const row = await env.DB.prepare('SELECT state, payload_json, provider_email_id FROM outbox WHERE job_id = ?')
    .bind(event.jobId).first();
  if (!row || !['sending', 'uncertain', 'accepted', 'sent'].includes(row.state) ||
      (row.provider_email_id && row.provider_email_id !== event.providerEmailId)) return { accepted: false };
  let payload;
  try { payload = JSON.parse(row.payload_json); }
  catch { return { accepted: false }; }
  if (payload.tags?.some(({ name, value }) => name === 'tagmails_job' && value === event.jobId) !== true ||
      payload.from !== event.from || await openText(env, payload.subject) !== event.subject ||
      !Array.isArray(payload.to) ||
      ![...payload.to, ...(payload.cc ?? [])].includes(event.recipient)) return { accepted: false };
  await env.DB.prepare(`INSERT INTO delivery_recipients
    (job_id, provider_email_id, recipient_email, status, event_at, event_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id, provider_email_id, recipient_email) DO UPDATE SET
      status = excluded.status, event_at = excluded.event_at, event_id = excluded.event_id
      WHERE excluded.event_at > delivery_recipients.event_at`)
    .bind(event.jobId, event.providerEmailId, event.recipient, event.status,
      event.eventAt, event.eventId ?? null).run();
  if (['bounced', 'failed', 'suppressed'].includes(event.status)) {
    await releaseFailedPrimaryTestEmail(env, event.jobId);
  }
  return { accepted: true, deliveryOutcome: true };
}

export async function reconcileOneUnknownOutbox(env, {
  listSentEmails = (options) => new Resend(env.RESEND_API_KEY).emails.list(options),
  getSentEmail = (id) => new Resend(env.RESEND_API_KEY).emails.get(id),
} = {}) {
  if (!env.DB || !env.RESEND_API_KEY) throw new Error('Outbound reconciliation bindings are incomplete');
  // A provider lookup is read-only. Scan one held reply at most once every
  // 15 minutes, and never infer acceptance from recipients or subject alone.
  const row = await env.DB.prepare(`UPDATE outbox SET updated_at = CURRENT_TIMESTAMP
    WHERE job_id = (SELECT job_id FROM outbox WHERE state = 'uncertain' AND payload_json IS NOT NULL
      AND updated_at <= datetime('now', '-15 minutes') ORDER BY updated_at, job_id LIMIT 1)
    AND state = 'uncertain' RETURNING job_id, payload_json`).bind().first();
  if (!row) return { state: 'idle' };
  let payload;
  try { payload = JSON.parse(row.payload_json); }
  catch { return { state: 'uncertain', jobId: row.job_id }; }
  let page;
  try { page = await listSentEmails({ limit: 100 }); }
  catch { return { state: 'uncertain', jobId: row.job_id }; }
  if (page?.error || !Array.isArray(page?.data?.data)) return { state: 'uncertain', jobId: row.job_id };
  let checked = 0;
  for (const summary of page.data.data) {
    if (checked >= 10) break;
    try {
      if (payload.from !== providerMailbox(summary.from) || await openText(env, payload.subject) !== summary.subject ||
          !sameRecipients(payload.to, providerRecipients(summary.to)) ||
          !sameRecipients(payload.cc ?? [], providerRecipients(summary.cc))) continue;
    } catch { continue; }
    checked += 1;
    let retrieved;
    try { retrieved = await getSentEmail(summary.id); }
    catch { continue; }
    const email = retrieved?.data;
    if (retrieved?.error || email?.id !== summary.id ||
        email.tags?.some(({ name, value }) => name === 'tagmails_job' && value === row.job_id) !== true ||
        !MESSAGE_ID.test(email.message_id ?? '')) continue;
    let event;
    try { event = { jobId: row.job_id, providerEmailId: email.id, messageId: email.message_id,
      from: providerMailbox(email.from), to: providerRecipients(email.to),
      cc: providerRecipients(email.cc), subject: email.subject }; }
    catch { continue; }
    const matched = await reconcileSentEvent(env, event);
    if (matched.accepted) return { state: 'accepted', jobId: row.job_id };
  }
  return { state: 'uncertain', jobId: row.job_id };
}

async function prepare(env, row) {
  const inbound = await env.DB.prepare(`SELECT m.object_key, m.message_id, m.sender_email,
      t.subject, a.owner_email, a.agent_email, COALESCE(m.agent_email, a.agent_email) AS received_agent_email, j.model_json, j.workspace_json
    FROM jobs j JOIN messages m ON m.id = j.message_id
    JOIN threads t ON t.id = j.thread_id JOIN accounts a ON a.id = t.account_id
    WHERE j.id = ? LIMIT 1`).bind(row.job_id).first();
  if (!inbound || !row.result_key) throw new InvalidOutboxSource('Outbox job has no complete source');
  const raw = await env.MAIL.get(inbound.object_key);
  const saved = await env.MAIL.get(row.result_key);
  if (!raw || !saved) throw new InvalidOutboxSource('Outbox source is missing from mail storage');
  const rawBytes = await raw.arrayBuffer();
  let request;
  try {
    request = await parseInbound(rawBytes, inbound.received_agent_email, {
      verifiedDeliveryToAgent: true, ...RELAY_INBOUND_LIMITS, includeAttachmentData: false,
    });
  } catch { throw new InvalidOutboxSource('Stored inbound MIME cannot be parsed'); }
  if (request.messageId !== inbound.message_id || request.from !== inbound.sender_email) {
    throw new InvalidOutboxSource('Outbox source no longer matches the verified inbound message');
  }
  const resultBytes = await saved.arrayBuffer();
  let result;
  try { result = JSON.parse(new TextDecoder().decode(resultBytes)); }
  catch { throw new InvalidOutboxSource('Stored result cannot be parsed'); }
  const owner = inbound.owner_email.toLowerCase();
  const agent = inbound.agent_email.toLowerCase();
  if (request.from !== owner) {
    const sender = await env.DB.prepare('SELECT email FROM participants WHERE thread_id = ? AND email = ? AND revoked_at IS NULL')
      .bind(row.thread_id, request.from).first();
    if (!sender) return null;
  }
  const receivedAgent = inbound.received_agent_email.toLowerCase();
  const agentAddresses = await knownAgentAddresses(env.DB, [...request.to, ...request.cc]);
  const recipients = [...new Set([...request.to, ...request.cc])].filter((email) =>
    !agentAddresses.has(email) && email !== agent && email !== receivedAgent && email !== request.from);
  const visible = [];
  for (const email of recipients) {
    if (email === owner) { visible.push(email); continue; }
    const guest = await env.DB.prepare('SELECT email FROM participants WHERE thread_id = ? AND email = ? AND revoked_at IS NULL')
      .bind(row.thread_id, email).first();
    if (guest) visible.push(email);
  }
  // Each reply follows the latest message's visible recipient list. A guest
  // cannot bring a new address into the conversation by copying it.
  const to = [request.from];
  const cc = visible;
  const testSender = testSenderFor(env, agent);
  if (testSender) {
    if (testSender !== 'onboarding@resend.dev') throw new Error('Unsupported Resend test sender');
    // Resend's test sender is for a single account-owned delivery. Keep
    // participant mail behind a verified sending domain.
    if (to[0] !== owner || cc.length) return null;
  }
  const references = [...new Set([...request.parentIds, request.messageId])].filter((id) => MESSAGE_ID.test(id)).slice(-40);
  const siteOrigin = publicOrigin(env.SITE_ORIGIN);
  const relayOrigin = publicOrigin(env.PUBLIC_ORIGIN);
  const ownerCanOpen = [request.from, ...visible].includes(owner);
  // The owner opens the email inline on their page; a guest on a shared
  // thread can't sign in there, so they keep the standalone run page.
  const sharedReply = [...to, ...cc].some((email) => email !== owner);
  const transcriptUrl = siteOrigin
    ? sharedReply ? `${siteOrigin}/run?id=${encodeURIComponent(row.job_id)}`
      : `${siteOrigin}/?run=${encodeURIComponent(row.job_id)}#emails`
    : relayOrigin ? `${relayOrigin}/runs/${encodeURIComponent(row.job_id)}` : null;
  const participantTranscriptReady = siteOrigin && env.SITE_PARTICIPANT_TRANSCRIPTS === 'true';
  const sharedWithParticipant = [...to, ...cc].some((email) => email !== owner);
  const ownerOnly = to.length === 1 && to[0] === owner && cc.length === 0;
  // Gmail drops codex:// and claude:// hrefs, so the owner's link goes through
  // a Site page that hands off to the app that ran the session.
  const session = ['codex', 'claude'].includes(result.session?.harness) &&
    /^[0-9a-f-]{36}$/i.test(result.session?.id ?? '') ? result.session : null;
  const openInApp = session && siteOrigin && ownerOnly;
  const runLinkLabel = openInApp ? `Open in ${session.harness === 'claude' ? 'Claude' : 'Codex'}`
    : result.runtime === 'relay' ? 'Run details' : 'Transcript';
  const selectedModel = selectedModelStatus(inbound.model_json);
  let projectName = null;
  try { projectName = JSON.parse(inbound.workspace_json ?? 'null')?.name ?? null; } catch { /* Older jobs have no folder. */ }
  const attachments = [];
  const files = ownerOnly && result.state === 'completed'
    ? await selectedRunArtifacts(env, row.account_id, row.job_id, result.artifactIds) : [];
  let attachedBytes = 0;
  for (const file of files) {
    if (attachedBytes + file.byte_size > ATTACHABLE_BYTES || !EMAIL_SAFE_FILE.test(file.name ?? '')) continue;
    const source = await artifactForDownload(env, row.account_id, row.job_id, file.id);
    if (!source) continue;
    const stored = await env.MAIL.get(source.object_key);
    if (!stored) throw new InvalidOutboxSource('Selected email attachment is missing');
    const bytes = Buffer.from(await stored.arrayBuffer());
    if (bytes.length !== source.byte_size || (source.sha256 &&
        createHash('sha256').update(bytes).digest('hex') !== source.sha256)) {
      throw new InvalidOutboxSource('Selected email attachment does not match its saved bytes');
    }
    attachments.push({ filename: source.name, contentType: source.mime_type,
      content: bytes.toString('base64') });
    attachedBytes += bytes.length;
  }
  const fileNote = [
    ...(files.length > attachments.length && siteOrigin
      ? [`${files.length - attachments.length} file${files.length - attachments.length === 1 ? '' : 's'} · 7 days`] : []),
  ];
  const balance = ownerOnly && testBillingEnabled(env)
    ? await testWalletSnapshot(env, row.account_id) : null;
  const charge = balance
    ? await env.DB.prepare('SELECT state FROM test_email_charges WHERE job_id = ?').bind(row.job_id).first()
    : null;
  const noChargeDetail = charge?.state === 'released'
    ? 'No charge' : null;
  const balanceDetail = balance
    ? `Balance $${(balance.balanceCents / 100).toFixed(2)}` : null;
  const allowance = ownerOnly && result.codexAllowance;
  const allowanceFresh = allowance && Number.isSafeInteger(allowance.observedAt) &&
    Date.now() >= allowance.observedAt && Date.now() - allowance.observedAt <= 15 * 60_000;
  const allowanceDetail = allowanceFresh && Array.isArray(allowance.windows)
    ? allowance.windows.filter((window) => Number.isInteger(window.remainingPercent) &&
      window.remainingPercent >= 0 && window.remainingPercent <= 100 &&
      Number.isSafeInteger(window.durationMins) && window.durationMins > 0 &&
      Number.isSafeInteger(window.resetsAt) && window.resetsAt * 1000 > Date.now())
      .map((window) => {
        const duration = window.durationMins % 1440 === 0
          ? `${window.durationMins / 1440}-day` : window.durationMins % 60 === 0
            ? `${window.durationMins / 60}-hour` : `${window.durationMins}-minute`;
        return `Codex ${window.remainingPercent}% (${duration})`;
      }) : [];
  const writeRun = ['codex-app-server-write', 'claude-cli-write'].includes(result.runtime);
  const rendered = renderResult({
    state: result.state, summary: result.summary,
    details: result.details, answer: result.answer,
    meta: [...(selectedModel && result.state !== 'needs_clarification'
      ? selectedModel.split(' · ') : []), ...(projectName ? [`in ${projectName}`] : []), ...fileNote, ...(noChargeDetail ? [noChargeDetail] : []),
      ...(balanceDetail ? [balanceDetail] : []), ...allowanceDetail],
    checks: result.checks,
    links: transcriptUrl && result.runtime !== 'relay' && (ownerCanOpen || participantTranscriptReady)
      ? [{ label: sharedWithParticipant && !participantTranscriptReady ? `${runLinkLabel} (owner only)` : runLinkLabel,
        url: openInApp ? `${siteOrigin}/open.html#${session.harness}/${session.id.toLowerCase()}` : transcriptUrl }] : [],
    brandUrl: siteOrigin,
    note: result.runtime === 'relay' ? null
      : result.state === 'needs_approval'
      ? 'No action was approved automatically. Review the request and local permissions before replying or retrying.'
      : writeRun && result.state === 'completed'
        ? 'This reply is the agent\'s report. Verify local file changes before relying on them.'
      : null,
  });
  inbound.subject = await openText(env, inbound.subject);
  if (/[\r\n]/.test(inbound.subject)) throw new InvalidOutboxSource('Outbox subject contains a line break');
  return {
    from: testSender ?? agent, ...(testSender ? { replyTo: agent } : {}),
    to, ...(cc.length ? { cc } : {}),
    subject: /^re\s*:/i.test(inbound.subject) ? inbound.subject : `Re: ${inbound.subject}`,
    html: rendered.html, text: rendered.text,
    ...(attachments.length ? { attachments } : {}),
    tags: [{ name: 'tagmails_job', value: row.job_id }],
    headers: { 'In-Reply-To': request.messageId, References: references.join(' ') },
  };
}

async function recipientsStillAuthorized(env, threadId, payload) {
  const account = await env.DB.prepare(`SELECT a.owner_email FROM threads t
    JOIN accounts a ON a.id = t.account_id WHERE t.id = ? AND a.active = 1`)
    .bind(threadId).first();
  if (!account) return false;
  const participants = await env.DB.prepare(`SELECT email FROM participants
    WHERE thread_id = ? AND revoked_at IS NULL`).bind(threadId).all();
  const allowed = new Set([account.owner_email, ...(participants.results ?? participants).map((row) => row.email)]);
  return [...payload.to, ...(payload.cc ?? [])].every((email) => allowed.has(email));
}

async function finalize(env, row, getSentEmail) {
  await settleTestEmail(env, row.job_id);
  await releaseFailedPrimaryTestEmail(env, row.job_id);
  // A verified sent webhook may have recorded the Message-ID already.
  const recorded = await env.DB.prepare(`SELECT message_id FROM messages
    WHERE thread_id = ? AND provider_email_id = ? AND direction = 'outbound'`)
    .bind(row.thread_id, row.provider_email_id).first();
  let messageId = recorded?.message_id;
  if (!messageId) {
    try {
      const { data, error } = await getSentEmail(row.provider_email_id);
      if (!error && MESSAGE_ID.test(data?.message_id ?? '')) messageId = data.message_id;
    } catch { /* Provider lookup can recover on a later scheduled run. */ }
  }
  if (!messageId) {
    await env.DB.prepare("UPDATE outbox SET updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND state = 'accepted'")
      .bind(row.job_id).run();
    return { state: 'accepted', jobId: row.job_id };
  }
  if (!recorded) await saveOutboundMessage(env, row.job_id, row.thread_id, row.provider_email_id, messageId);
  await env.DB.prepare("UPDATE outbox SET state = 'sent', updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND state = 'accepted'")
    .bind(row.job_id).run();
  return { state: 'sent', jobId: row.job_id, messageId };
}

async function holdUnknownSend(env, jobId) {
  const changed = await env.DB.prepare(`UPDATE outbox SET state = 'uncertain', updated_at = CURRENT_TIMESTAMP
    WHERE job_id = ? AND state = 'sending' RETURNING job_id`).bind(jobId).first();
  if (changed) return { state: 'uncertain', jobId };
  const current = await env.DB.prepare('SELECT state FROM outbox WHERE job_id = ?').bind(jobId).first();
  return { state: current?.state ?? 'uncertain', jobId };
}

export async function purgeSettledOutboundBodies(env) {
  const found = await env.DB.prepare(`SELECT o.job_id, o.payload_json, t.account_id
    FROM outbox o JOIN jobs j ON j.id = o.job_id
    JOIN threads t ON t.id = j.thread_id
    WHERE o.state IN ('accepted', 'sent') AND o.payload_json IS NOT NULL
      AND (json_type(o.payload_json, '$.bodyStored') IS NOT NULL OR
        json_type(o.payload_json, '$.html') IS NOT NULL OR json_type(o.payload_json, '$.text') IS NOT NULL)
    ORDER BY o.updated_at, o.job_id LIMIT 20`).bind().all();
  let purged = 0;
  for (const row of found.results ?? found) {
    let payload;
    try { payload = JSON.parse(row.payload_json); }
    catch { continue; }
    if (typeof payload.subject !== 'string' || typeof payload.from !== 'string' ||
        !Array.isArray(payload.to) || !Array.isArray(payload.tags)) continue;
    const compact = {
      from: payload.from, to: payload.to,
      ...(Array.isArray(payload.cc) ? { cc: payload.cc } : {}),
      subject: payload.subject,
      tags: payload.tags,
    };
    try {
      await env.MAIL.delete(`outbound/${row.account_id}/${row.job_id}.json`);
      const updated = await env.DB.prepare(`UPDATE outbox SET payload_json = ?
        WHERE job_id = ? AND state IN ('accepted', 'sent') AND payload_json = ?`)
        .bind(JSON.stringify(compact), row.job_id, row.payload_json).run();
      if ((updated.meta?.changes ?? updated.changes) === 1) purged += 1;
    } catch { console.error('Settled outbound body cleanup is delayed', row.job_id); }
  }
  return purged;
}

export async function sendNextOutbox(env, {
  // Cloudflare Email Sending when the EMAIL binding exists; Resend otherwise.
  // Saved payloads keep the bare address for sender checks; mail shows a display name.
  sendEmail = env.EMAIL ? (payload) => sendWithCloudflare(env, payload)
    : (payload, options) => new Resend(env.RESEND_API_KEY).emails.send(
      { ...payload, from: `TagMails <${payload.from}>` }, options),
  // Cloudflare returns the sent message's ID directly; Resend needs a lookup.
  getSentEmail = env.EMAIL ? async (id) => ({ data: { id, message_id: cloudflareMessageId(id) } })
    : (id) => new Resend(env.RESEND_API_KEY).emails.get(id),
} = {}) {
  if (!env.DB || !env.MAIL || (!env.RESEND_API_KEY && !env.EMAIL)) throw new Error('Outbound bindings are incomplete');
  // Scheduled invocations cannot run beyond 15 minutes. A send still marked
  // in progress after 20 minutes might already have reached the provider.
  const stale = await env.DB.prepare(`UPDATE outbox SET state = 'uncertain', updated_at = CURRENT_TIMESTAMP
    WHERE job_id = (SELECT job_id FROM outbox WHERE state = 'sending'
      AND updated_at <= datetime('now', '-20 minutes') ORDER BY updated_at, job_id LIMIT 1)
    AND state = 'sending' RETURNING job_id`).bind().first();
  if (stale) {
    console.error('Outbox send needs reconciliation after interrupted Worker', stale.job_id);
    return { state: 'uncertain', jobId: stale.job_id };
  }
  const accepted = await env.DB.prepare(`SELECT o.job_id, o.provider_email_id, j.thread_id
    FROM outbox o JOIN jobs j ON j.id = o.job_id
    JOIN threads t ON t.id = j.thread_id JOIN accounts a ON a.id = t.account_id
    WHERE o.state = 'accepted' AND a.active = 1
      AND (o.updated_at <= datetime('now', '-1 minute') OR EXISTS (
        SELECT 1 FROM messages m WHERE m.thread_id = j.thread_id
          AND m.provider_email_id = o.provider_email_id AND m.direction = 'outbound'))
    ORDER BY o.updated_at, o.job_id LIMIT 1`).bind().first();
  if (accepted) return finalize(env, accepted, getSentEmail);

  const row = await env.DB.prepare(`SELECT o.job_id, j.thread_id, j.result_key, t.account_id, a.agent_email
    FROM outbox o JOIN jobs j ON j.id = o.job_id JOIN threads t ON t.id = j.thread_id
    JOIN accounts a ON a.id = t.account_id
    WHERE o.state = 'queued' AND a.active = 1
      AND NOT EXISTS (SELECT 1 FROM jobs earlier
        JOIN outbox prior ON prior.job_id = earlier.id
        WHERE earlier.thread_id = j.thread_id AND earlier.rowid < j.rowid
          AND prior.state IN ('queued', 'sending', 'uncertain', 'accepted'))
    ORDER BY j.created_at, j.rowid LIMIT 1`).bind().first();
  if (!row) return { state: 'idle' };
  let payload;
  try { payload = await prepare(env, row); }
  catch (error) {
    if (!(error instanceof InvalidOutboxSource)) throw error;
    const blocked = await env.DB.prepare("UPDATE outbox SET state = 'blocked', updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND state = 'queued' RETURNING job_id")
      .bind(row.job_id).first();
    if (!blocked) return { state: 'contended' };
    await releaseTestEmail(env, row.job_id);
    console.error('Outbox source needs operator review', row.job_id, error.message);
    return { state: 'blocked', jobId: row.job_id };
  }
  if (!payload) {
    await env.DB.prepare("UPDATE outbox SET state = 'blocked', updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND state = 'queued'")
      .bind(row.job_id).run();
    await releaseTestEmail(env, row.job_id);
    return { state: 'blocked', jobId: row.job_id };
  }
  if (payload.from !== (testSenderFor(env, row.agent_email) ?? row.agent_email.toLowerCase())) {
    throw new Error('Outbox sender does not match its account');
  }
  // D1 keeps only routing metadata; the body and attachments live in the
  // encrypted R2 copy below until the send settles.
  const { html: _html, text: _text, attachments, ...metadata } = payload;
  const savedPayload = { ...metadata, subject: await sealText(env, payload.subject), bodyStored: true,
    ...(attachments ? { attachments: attachments.map(({ filename, contentType }) => ({ filename, contentType })) } : {}) };
  const claimed = await env.DB.prepare(`UPDATE outbox SET state = 'sending', payload_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE job_id = ? AND state = 'queued' RETURNING job_id`).bind(JSON.stringify(savedPayload), row.job_id).first();
  if (!claimed) return { state: 'contended' };
  const objectKey = `outbound/${row.account_id}/${row.job_id}.json`;
  try {
    await env.MAIL.put(objectKey, JSON.stringify(payload), { httpMetadata: { contentType: 'application/json' } });
  } catch (error) {
    await env.DB.prepare("UPDATE outbox SET state = 'queued', payload_json = NULL WHERE job_id = ? AND state = 'sending'")
      .bind(row.job_id).run();
    throw error;
  }
  if (!await recipientsStillAuthorized(env, row.thread_id, payload)) {
    await env.DB.prepare("UPDATE outbox SET state = 'blocked', payload_json = NULL, updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND state = 'sending'")
      .bind(row.job_id).run();
    await releaseTestEmail(env, row.job_id);
    try { await env.MAIL.delete(objectKey); }
    catch (error) { console.error('Blocked outbox payload deletion is delayed', error); }
    return { state: 'blocked', jobId: row.job_id };
  }
  let sent;
  try {
    sent = await sendEmail(payload, { idempotencyKey: `tagmails-job-${row.job_id}` });
  } catch {
    // A network error might happen after provider acceptance. Hold for
    // reconciliation rather than risk a duplicate when its 24h key expires.
    return holdUnknownSend(env, row.job_id);
  }
  if (sent.error || !sent.data?.id) {
    return holdUnknownSend(env, row.job_id);
  }
  const acceptedSend = await env.DB.prepare("UPDATE outbox SET state = 'accepted', provider_email_id = ?, updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND state = 'sending' RETURNING job_id")
    .bind(sent.data.id, row.job_id).first();
  if (!acceptedSend) {
    const current = await env.DB.prepare('SELECT state, provider_email_id FROM outbox WHERE job_id = ?')
      .bind(row.job_id).first();
    if (current?.provider_email_id === sent.data.id && ['accepted', 'sent'].includes(current.state)) {
      return { state: current.state, jobId: row.job_id };
    }
    throw new Error('Outbox provider acceptance conflicts with stored state');
  }
  return finalize(env, { ...row, provider_email_id: sent.data.id }, getSentEmail);
}
