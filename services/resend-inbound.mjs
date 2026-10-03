import { addressParser } from 'postal-mime';
import { Resend } from 'resend';
import { parseInbound } from '../apps/mock-inbox/inbound.mjs';

const MAX_RAW_BYTES = 5 * 1024 * 1024;
const MESSAGE_ID = /^<[^<>\s]+@[^<>\s]+>$/;
const EMAIL_ID = /^[0-9a-f-]{36}$/i;

function mailbox(value) {
  const addresses = addressParser(String(value ?? ''));
  if (addresses.length !== 1 || !addresses[0].address) throw new Error('Expected one sender mailbox');
  return addresses[0].address.toLowerCase();
}

function recipients(value) {
  return (Array.isArray(value) ? value : []).map(mailbox);
}

function header(headers, name) {
  return headers?.get?.(name) ?? headers?.[name] ?? headers?.[name.toLowerCase()];
}

function deliveredTo(email, address) {
  return ['to', 'cc', 'bcc', 'received_for'].some((field) => recipients(email[field]).includes(address));
}

async function boundedRaw(response) {
  if (!response.ok) throw new Error('Resend raw email could not be retrieved');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_RAW_BYTES) throw new Error('Resend raw email exceeds 5 MB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function inspectResendInbound({ rawPayload, headers, webhookSecret, apiKey, agentAddress, getReceivedEmail, fetchRaw = fetch }) {
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
  if (event?.type !== 'email.received') return { ignored: true };
  const metadata = event.data;
  const agent = mailbox(agentAddress);
  if (!EMAIL_ID.test(metadata?.email_id || '') || !MESSAGE_ID.test(metadata?.message_id || '') || !deliveredTo(metadata, agent)) {
    throw new Error('Resend event does not identify an email delivered to this agent');
  }

  const email = await getReceivedEmail(metadata.email_id);
  if (!email || email.id !== metadata.email_id || email.message_id !== metadata.message_id ||
      mailbox(email.from) !== mailbox(metadata.from) || !deliveredTo(email, agent)) {
    throw new Error('Retrieved Resend email does not match the verified event');
  }
  if (email.authentication?.dmarc !== 'pass') throw new Error('Sender authentication did not pass DMARC');
  const rawUrl = new URL(email.raw?.download_url || '');
  if (rawUrl.protocol !== 'https:' || !(rawUrl.hostname === 'resend.com' || rawUrl.hostname.endsWith('.resend.com'))) {
    throw new Error('Resend raw email URL is outside the provider domain');
  }
  const parsed = await parseInbound(await boundedRaw(await fetchRaw(rawUrl.href)), agent, { verifiedDeliveryToAgent: true });
  if (parsed.messageId !== metadata.message_id || parsed.from !== mailbox(metadata.from)) {
    throw new Error('Raw email does not match the verified Resend metadata');
  }
  return {
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
  };
}
