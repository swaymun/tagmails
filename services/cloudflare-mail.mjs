// Mail through Cloudflare Email Routing (inbound to the Worker's email()
// handler) and Email Sending (the EMAIL binding). No third-party dashboard
// keeps message bodies; sender identity comes from our own DKIM check.
import { parseInbound, RELAY_INBOUND_LIMITS } from '../apps/mock-inbox/inbound.mjs';
import { verifyDkim } from './dkim.mjs';

export const CLOUDFLARE_MAX_INBOUND_BYTES = 25 * 1024 * 1024;

async function readRaw(stream, limit) {
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('Inbound email is too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const raw = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
  return raw;
}

async function digest(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Turns a Cloudflare ForwardableEmailMessage into the relay's message shape.
 * Returns { ignored: true, reason } for mail the relay must not act on.
 */
export async function inspectCloudflareInbound(message, { resolveAgentAddress, resolveTxt } = {}) {
  if (message.rawSize > CLOUDFLARE_MAX_INBOUND_BYTES) return { ignored: true, reason: 'too large' };
  const envelopeTo = String(message.to ?? '').trim().toLowerCase();
  const agent = await resolveAgentAddress([envelopeTo]);
  if (!agent) return { ignored: true, reason: 'unknown recipient' };
  const raw = await readRaw(message.raw, CLOUDFLARE_MAX_INBOUND_BYTES);
  const rawMime = Buffer.from(raw);
  let parsed;
  try {
    parsed = await parseInbound(rawMime, agent, {
      verifiedDeliveryToAgent: true, ...RELAY_INBOUND_LIMITS, maxRawBytes: CLOUDFLARE_MAX_INBOUND_BYTES,
      includeAttachmentData: false,
    });
  } catch (error) { return { ignored: true, reason: error.message }; }
  // Only a valid signature from the sender's own domain proves who sent it.
  const dkim = await verifyDkim(raw, parsed.from, resolveTxt ? { resolveTxt } : {});
  if (!dkim.pass) return { ignored: true, reason: 'sender authentication failed' };
  // The sender must have addressed the agent in a signed To or Cc. Otherwise
  // any mail the owner sent elsewhere could be re-sent here and pass DKIM.
  // Bcc to the agent is therefore not supported on this path.
  const signedTo = dkim.signedHeaders.includes('to') && (parsed.to ?? []).includes(agent);
  const signedCc = dkim.signedHeaders.includes('cc') && (parsed.cc ?? []).includes(agent);
  if (!signedTo && !signedCc) return { ignored: true, reason: 'agent not in signed To or Cc' };
  return {
    agentAddress: agent,
    providerEmailId: `cf-${(await digest(raw)).slice(0, 32)}`,
    from: parsed.from,
    to: parsed.to ?? [],
    cc: parsed.cc ?? [],
    bcc: [],
    subject: parsed.subject,
    body: parsed.body,
    messageId: parsed.messageId,
    parentIds: parsed.parentIds ?? [],
    attachments: parsed.attachments ?? [],
    reaction: parsed.reaction,
    reactionTargetId: parsed.reactionTargetId,
    rawMime,
  };
}

/**
 * Sends one outbox payload ({ from, to, cc, replyTo, subject, html, text,
 * attachments, headers }) through the EMAIL binding. The result mirrors the
 * Resend SDK's { data: { id } } so the outbox can treat both alike.
 */
export async function sendWithCloudflare(env, payload) {
  const headers = {};
  for (const [name, value] of Object.entries(payload.headers ?? {})) {
    if (['In-Reply-To', 'References'].includes(name) || name.startsWith('X-')) headers[name] = value;
  }
  for (const tag of payload.tags ?? []) headers[`X-TagMails-${tag.name.replace(/[^A-Za-z0-9-]/g, '-')}`] = tag.value;
  const result = await env.EMAIL.send({
    from: { email: payload.from, name: senderName(payload) },
    to: payload.to,
    ...(payload.cc?.length ? { cc: payload.cc } : {}),
    ...(payload.replyTo ? { replyTo: payload.replyTo } : {}),
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
    headers,
    ...(payload.attachments?.length ? { attachments: payload.attachments.map((file) => ({
      content: file.content, filename: file.filename, type: file.contentType || 'application/octet-stream',
      disposition: 'attachment' })) } : {}),
  });
  return { data: { id: result.messageId } };
}

// The agent's own name (the part before @ in its address) is the display name, so mail shows as "swagbot".
export function senderName({ from, replyTo }) {
  const name = String(replyTo ?? from ?? '').split('@')[0].replace(/[^\w.+-]/g, '');
  return name || 'TagMails';
}

export function cloudflareMessageId(id) {
  if (!id) return null;
  return /^<[^<>\s]+@[^<>\s]+>$/.test(id) ? id : /^[^<>\s]+@[^<>\s]+$/.test(id) ? `<${id}>` : null;
}

// Gmail status reactions are a hand-built MIME message, sent as raw mail.
export async function sendRawWithCloudflare(env, { from, to, raw }) {
  const { EmailMessage } = await import('cloudflare:email');
  await env.EMAIL.send(new EmailMessage(from, to, raw));
  return { accepted: true };
}
