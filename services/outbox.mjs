import { randomUUID } from 'node:crypto';
import { Resend } from 'resend';
import { parseInbound } from '../apps/mock-inbox/inbound.mjs';
import { renderResult } from '../apps/mock-inbox/mail.mjs';
import { releaseTestEmail, settleTestEmail } from './email-charges.mjs';

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

async function prepare(env, row) {
  const inbound = await env.DB.prepare(`SELECT m.object_key, m.message_id, m.sender_email,
      t.subject, a.owner_email, a.agent_email
    FROM jobs j JOIN messages m ON m.id = j.message_id
    JOIN threads t ON t.id = j.thread_id JOIN accounts a ON a.id = t.account_id
    WHERE j.id = ? LIMIT 1`).bind(row.job_id).first();
  if (!inbound) throw new Error('Outbox job has no inbound message');
  const raw = await env.MAIL.get(inbound.object_key);
  const saved = await env.MAIL.get(row.result_key);
  if (!raw || !saved) throw new Error('Outbox source is missing from mail storage');
  const request = await parseInbound(await raw.arrayBuffer(), inbound.agent_email, { verifiedDeliveryToAgent: true });
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
  const rendered = renderResult({
    state: result.state, summary: result.summary, details: [...(result.details ?? []), ...fileNote], checks: result.checks,
    links: transcriptUrl && ownerCanOpen ? [{ label: 'Run transcript', url: transcriptUrl }] : [],
    note: result.state === 'needs_approval'
      ? 'The agent is waiting for your approval in the connected app.'
      : 'This summary came from your connected local agent.',
  });
  if (/[\r\n]/.test(inbound.subject)) throw new Error('Outbox subject contains a line break');
  return {
    from: testSender ?? agent, ...(testSender ? { replyTo: agent } : {}),
    to, ...(cc.length ? { cc } : {}),
    subject: /^re\s*:/i.test(inbound.subject) ? inbound.subject : `Re: ${inbound.subject}`,
    html: rendered.html, text: rendered.text,
    headers: { 'In-Reply-To': request.messageId, References: references.join(' ') },
  };
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
      VALUES (?, ?, ?, ?, ?, 'outbound', ?, ?)`)
      .bind(randomUUID(), account.account_id, row.thread_id, row.provider_email_id, data.message_id,
        account.agent_email, `outbound/${account.account_id}/${row.job_id}.json`),
    env.DB.prepare("UPDATE outbox SET state = 'sent', updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND state = 'accepted'")
      .bind(row.job_id),
  ]);
  return { state: 'sent', jobId: row.job_id, messageId: data.message_id };
}

export async function sendNextOutbox(env, {
  sendEmail = (payload, options) => new Resend(env.RESEND_API_KEY).emails.send(payload, options),
  getSentEmail = (id) => new Resend(env.RESEND_API_KEY).emails.get(id),
} = {}) {
  if (!env.DB || !env.MAIL || !env.RESEND_API_KEY) throw new Error('Outbound bindings are incomplete');
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
  let sent;
  try {
    sent = await sendEmail(payload, { idempotencyKey: `tagmails-job-${row.job_id}` });
  } catch {
    // A network error might happen after provider acceptance. Hold for
    // reconciliation rather than risk a duplicate when its 24h key expires.
    await env.DB.prepare("UPDATE outbox SET state = 'uncertain', updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND state = 'sending'")
      .bind(row.job_id).run();
    return { state: 'uncertain', jobId: row.job_id };
  }
  if (sent.error || !sent.data?.id) {
    await env.DB.prepare("UPDATE outbox SET state = 'uncertain', updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND state = 'sending'")
      .bind(row.job_id).run();
    return { state: 'uncertain', jobId: row.job_id };
  }
  await env.DB.prepare("UPDATE outbox SET state = 'accepted', provider_email_id = ?, updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND state = 'sending'")
    .bind(sent.data.id, row.job_id).run();
  return finalize(env, { ...row, provider_email_id: sent.data.id }, getSentEmail);
}
