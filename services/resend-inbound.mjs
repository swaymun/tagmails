import { addressParser } from 'postal-mime';
import { Resend } from 'resend';
import { parseInbound, RELAY_INBOUND_LIMITS } from '../apps/mock-inbox/inbound.mjs';

const MESSAGE_ID = /^<[^<>\s]+@[^<>\s]+>$/;
const EMAIL_ID = /^[0-9a-f-]{36}$/i;
const DELIVERY_EVENTS = new Map([
  ['email.delivered', 'delivered'], ['email.delivery_delayed', 'delayed'],
  ['email.bounced', 'bounced'], ['email.failed', 'failed'], ['email.suppressed', 'suppressed'],
]);

function mailbox(value) {
  const addresses = addressParser(String(value ?? ''));
  if (addresses.length !== 1 || !addresses[0].address) throw new Error('Expected one sender mailbox');
  return addresses[0].address.toLowerCase();
}

function recipients(value) {
  return (Array.isArray(value) ? value : []).map(mailbox);
}

function recipientAddresses(email) {
  // received_for comes from a Received header, not a recipient field.
  return [...new Set(['to', 'cc', 'bcc'].flatMap((field) => recipients(email[field])))];
}

function header(headers, name) {
  return headers?.get?.(name) ?? headers?.[name] ?? headers?.[name.toLowerCase()];
}

function deliveredTo(email, address) {
  return recipientAddresses(email).includes(address);
}

async function boundedRaw(response) {
  if (!response.ok) throw new Error('Resend raw email could not be retrieved');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > RELAY_INBOUND_LIMITS.maxRawBytes) throw new Error('Resend raw email exceeds 38 MB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function inspectResendInbound({ rawPayload, headers, webhookSecret, apiKey, agentAddress, resolveAgentAddress, getReceivedEmail, fetchRaw = fetch }) {
  if (!webhookSecret || !apiKey || typeof getReceivedEmail !== 'function') throw new Error('Resend inbound verification is not configured');
  const verifier = new Resend(apiKey);
  const event = verifier.webhooks.verify({
    payload: rawPayload,
    headers: {
      id: header(headers, 'svix-id'),
      timestamp: header(headers, 'svix-timestamp'),
      signature: header(headers, 'svix-signature'),
    },
    webhookSecret,
  });
  if (event?.type === 'email.sent') {
    const data = event.data;
    const jobId = data?.tags?.tagmails_job;
    if (!/^[0-9a-f-]{36}$/i.test(jobId || '')) return { ignored: true };
    if (!EMAIL_ID.test(data?.email_id || '') || !MESSAGE_ID.test(data?.message_id || '') ||
        typeof data?.subject !== 'string') throw new Error('Resend sent event is incomplete');
    return { sent: { jobId, providerEmailId: data.email_id, messageId: data.message_id,
      from: mailbox(data.from), to: recipients(data.to), cc: recipients(data.cc), subject: data.subject } };
  }
  if (DELIVERY_EVENTS.has(event?.type)) {
    const data = event.data;
    const jobId = data?.tags?.tagmails_job;
    if (!/^[0-9a-f-]{36}$/i.test(jobId || '')) return { ignored: true };
    const to = recipients(data.to);
    const eventAt = Date.parse(event.created_at);
    if (!EMAIL_ID.test(data?.email_id || '') || !MESSAGE_ID.test(data?.message_id || '') ||
        typeof data?.subject !== 'string' || to.length !== 1 || !Number.isFinite(eventAt)) {
      throw new Error('Resend delivery event is incomplete');
    }
    return { deliveryOutcome: { jobId, providerEmailId: data.email_id,
      recipient: to[0], from: mailbox(data.from), subject: data.subject,
      status: DELIVERY_EVENTS.get(event.type), eventAt: new Date(eventAt).toISOString(),
      eventId: header(headers, 'svix-id') } };
  }
  if (event?.type !== 'email.received') return { ignored: true };
  const metadata = event.data;
  if (!EMAIL_ID.test(metadata?.email_id || '') || !MESSAGE_ID.test(metadata?.message_id || '')) {
    throw new Error('Resend event does not identify a received email');
  }
  const candidates = recipientAddresses(metadata);
  if (candidates.length > 100) throw new Error('Resend event has too many recipients');
  const selected = resolveAgentAddress ? await resolveAgentAddress(candidates) : agentAddress;
  if (!selected) return { ignored: true };
  const agent = mailbox(selected);
  if (!candidates.includes(agent)) {
    throw new Error('Resend event does not identify an email delivered to this agent');
  }

  const email = await getReceivedEmail(metadata.email_id);
  if (!email || email.id !== metadata.email_id || email.message_id !== metadata.message_id ||
      mailbox(email.from) !== mailbox(metadata.from) || !deliveredTo(email, agent)) {
    throw new Error('Retrieved Resend email does not match the verified event');
  }
  // Resend reports DMARC as "gray" for a p=none sender even when the
  // matching From domain has a valid DKIM signature. Personal Gmail currently
  // publishes p=none, so accept that documented combination as authenticated.
  const authentication = email.authentication;
  if (authentication?.dmarc !== 'pass' &&
      !(authentication?.dmarc === 'gray' && authentication?.dkim === 'pass')) {
    throw new Error('Sender authentication did not pass DMARC or aligned DKIM');
  }
  const rawUrl = new URL(email.raw?.download_url || '');
  if (rawUrl.protocol !== 'https:' || !(rawUrl.hostname === 'resend.com' || rawUrl.hostname.endsWith('.resend.com'))) {
    throw new Error('Resend raw email URL is outside the provider domain');
  }
  const rawMime = await boundedRaw(await fetchRaw(rawUrl.href, { redirect: 'error' }));
  const parsed = await parseInbound(rawMime, agent, {
    verifiedDeliveryToAgent: true, ...RELAY_INBOUND_LIMITS, includeAttachmentData: false,
  });
  if (parsed.messageId !== metadata.message_id || parsed.from !== mailbox(metadata.from)) {
    throw new Error('Raw email does not match the verified Resend metadata');
  }
  return {
    agentAddress: agent,
    providerEmailId: metadata.email_id,
    eventId: header(headers, 'svix-id'),
    from: parsed.from,
    to: parsed.to,
    cc: parsed.cc,
    bcc: [],
    subject: parsed.subject,
    body: parsed.body,
    messageId: parsed.messageId,
    parentIds: parsed.parentIds,
    attachments: parsed.attachments,
    reaction: parsed.reaction,
    reactionTargetId: parsed.reactionTargetId,
    rawMime,
  };
}
