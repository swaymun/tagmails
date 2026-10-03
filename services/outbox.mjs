import { randomUUID } from 'node:crypto';
import { Resend } from 'resend';
import { addressParser } from 'postal-mime';
import { parseInbound, RELAY_INBOUND_LIMITS } from '../apps/mock-inbox/inbound.mjs';
import { renderResult } from '../apps/mock-inbox/mail.mjs';
import { releaseTestEmail, settleTestEmail } from './email-charges.mjs';
import { selectedModelDetail } from './model-route.mjs';

const MESSAGE_ID = /^<[^<>\s]+@[^<>\s]+>$/;

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

function providerMailbox(value) {
  const addresses = addressParser(String(value ?? ''));
  if (addresses.length !== 1 || !addresses[0].address) throw new Error('Invalid provider mailbox');
  return addresses[0].address.toLowerCase();
}

function providerRecipients(value) {
  return (Array.isArray(value) ? value : []).map(providerMailbox);
}

export async function reconcileSentEvent(env, event) {
  const row = await env.DB.prepare('SELECT state, payload_json, provider_email_id FROM outbox WHERE job_id = ?')
    .bind(event.jobId).first();
  if (!row || !['sending', 'uncertain', 'accepted', 'sent'].includes(row.state)) return { accepted: false };
  let payload;
  try { payload = JSON.parse(row.payload_json); }
  catch { return { accepted: false }; }
  if (payload.tags?.some(({ name, value }) => name === 'tagmails_job' && value === event.jobId) !== true ||
      payload.from !== event.from || payload.subject !== event.subject ||
      !sameRecipients(payload.to, event.to) || !sameRecipients(payload.cc ?? [], event.cc) ||
      (row.provider_email_id && row.provider_email_id !== event.providerEmailId)) return { accepted: false };
  if (row.state === 'sent') return { accepted: true, duplicate: true };
  const updated = await env.DB.prepare(`UPDATE outbox SET state = 'accepted', provider_email_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE job_id = ? AND state IN ('sending', 'uncertain', 'accepted')
      AND (provider_email_id IS NULL OR provider_email_id = ?) RETURNING job_id`)
    .bind(event.providerEmailId, event.jobId, event.providerEmailId).first();
  return { accepted: Boolean(updated), sentEvent: true };
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
      if (payload.from !== providerMailbox(summary.from) || payload.subject !== summary.subject ||
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
      t.subject, a.owner_email, a.agent_email, j.model_json
    FROM jobs j JOIN messages m ON m.id = j.message_id
    JOIN threads t ON t.id = j.thread_id JOIN accounts a ON a.id = t.account_id
    WHERE j.id = ? LIMIT 1`).bind(row.job_id).first();
  if (!inbound) throw new Error('Outbox job has no inbound message');
  const raw = await env.MAIL.get(inbound.object_key);
  const saved = await env.MAIL.get(row.result_key);
  if (!raw || !saved) throw new Error('Outbox source is missing from mail storage');
  const request = await parseInbound(await raw.arrayBuffer(), inbound.agent_email, {
    verifiedDeliveryToAgent: true, ...RELAY_INBOUND_LIMITS, includeAttachmentData: false,
  });
  if (request.messageId !== inbound.message_id || request.from !== inbound.sender_email) {
    throw new Error('Outbox source no longer matches the verified inbound message');
  }
  const result = JSON.parse(new TextDecoder().decode(await saved.arrayBuffer()));
  const owner = inbound.owner_email.toLowerCase();
  const agent = inbound.agent_email.toLowerCase();
  if (request.from !== owner) {
    const sender = await env.DB.prepare('SELECT email FROM participants WHERE thread_id = ? AND email = ? AND revoked_at IS NULL')
      .bind(row.thread_id, request.from).first();
    if (!sender) return null;
  }
  const recipients = [...new Set([...request.to, ...request.cc])].filter((email) => email !== agent && email !== request.from);
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
  const testSender = env.RESEND_TEST_FROM;
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
  const transcriptUrl = siteOrigin
    ? `${siteOrigin}/run?id=${encodeURIComponent(row.job_id)}`
    : relayOrigin ? `${relayOrigin}/runs/${encodeURIComponent(row.job_id)}` : null;
  const fileNote = result.artifactIds?.length && ownerCanOpen && siteOrigin
    ? [`${result.artifactIds.length} file${result.artifactIds.length === 1 ? '' : 's'} available on the private run page for seven days.`]
    : [];
  const selectedModel = selectedModelDetail(inbound.model_json);
  const rendered = renderResult({
    state: result.state, summary: result.summary,
    details: [...(selectedModel ? [selectedModel] : []), ...(result.details ?? []), ...fileNote], checks: result.checks,
    links: transcriptUrl && ownerCanOpen ? [{ label: 'Run transcript', url: transcriptUrl }] : [],
    note: result.state === 'needs_approval'
      ? 'No action was approved automatically. Review the request and local permissions before replying or retrying.'
      : 'This summary came from your connected local agent.',
  });
  if (/[\r\n]/.test(inbound.subject)) throw new Error('Outbox subject contains a line break');
  return {
    from: testSender ?? agent, ...(testSender ? { replyTo: agent } : {}),
    to, ...(cc.length ? { cc } : {}),
    subject: /^re\s*:/i.test(inbound.subject) ? inbound.subject : `Re: ${inbound.subject}`,
    html: rendered.html, text: rendered.text,
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
  const { data, error } = await getSentEmail(row.provider_email_id);
  if (error || !data?.message_id || !MESSAGE_ID.test(data.message_id)) {
    return { state: 'accepted', jobId: row.job_id };
  }
  const account = await env.DB.prepare(`SELECT t.account_id, a.agent_email FROM jobs j
    JOIN threads t ON t.id = j.thread_id JOIN accounts a ON a.id = t.account_id
    WHERE j.id = ?`).bind(row.job_id).first();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO messages
      (id, account_id, thread_id, provider_email_id, message_id, direction, sender_email, object_key)
      VALUES (?, ?, ?, ?, ?, 'outbound', ?, ?)
      ON CONFLICT(account_id, provider_email_id) DO NOTHING`)
      .bind(randomUUID(), account.account_id, row.thread_id, row.provider_email_id, data.message_id,
        account.agent_email, `outbound/${account.account_id}/${row.job_id}.json`),
    env.DB.prepare("UPDATE outbox SET state = 'sent', updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND state = 'accepted'")
      .bind(row.job_id),
  ]);
  return { state: 'sent', jobId: row.job_id, messageId: data.message_id };
}

async function holdUnknownSend(env, jobId) {
  const changed = await env.DB.prepare(`UPDATE outbox SET state = 'uncertain', updated_at = CURRENT_TIMESTAMP
    WHERE job_id = ? AND state = 'sending' RETURNING job_id`).bind(jobId).first();
  if (changed) return { state: 'uncertain', jobId };
  const current = await env.DB.prepare('SELECT state FROM outbox WHERE job_id = ?').bind(jobId).first();
  return { state: current?.state ?? 'uncertain', jobId };
}

export async function sendNextOutbox(env, {
  sendEmail = (payload, options) => new Resend(env.RESEND_API_KEY).emails.send(payload, options),
  getSentEmail = (id) => new Resend(env.RESEND_API_KEY).emails.get(id),
} = {}) {
  if (!env.DB || !env.MAIL || !env.RESEND_API_KEY) throw new Error('Outbound bindings are incomplete');
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
    ORDER BY o.updated_at, o.job_id LIMIT 1`).bind().first();
  if (accepted) return finalize(env, accepted, getSentEmail);

  const row = await env.DB.prepare(`SELECT o.job_id, j.thread_id, j.result_key, t.account_id, a.agent_email
    FROM outbox o JOIN jobs j ON j.id = o.job_id JOIN threads t ON t.id = j.thread_id
    JOIN accounts a ON a.id = t.account_id
    WHERE o.state = 'queued' AND a.active = 1 ORDER BY o.updated_at, o.job_id LIMIT 1`).bind().first();
  if (!row) return { state: 'idle' };
  const payload = await prepare(env, row);
  if (!payload) {
    await env.DB.prepare("UPDATE outbox SET state = 'blocked', updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND state = 'queued'")
      .bind(row.job_id).run();
    await releaseTestEmail(env, row.job_id);
    return { state: 'blocked', jobId: row.job_id };
  }
  if (payload.from !== (env.RESEND_TEST_FROM ?? row.agent_email.toLowerCase())) {
    throw new Error('Outbox sender does not match its account');
  }
  const claimed = await env.DB.prepare(`UPDATE outbox SET state = 'sending', payload_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE job_id = ? AND state = 'queued' RETURNING job_id`).bind(JSON.stringify(payload), row.job_id).first();
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
