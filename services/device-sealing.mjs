// Content the relay keeps for a computer that registered a sealing key is
// sealed to that key (agent/device-seal.mjs), not to the relay's STORAGE_KEY,
// so the operator can't read it back. The relay still handles plaintext in
// memory while it authenticates, routes and sends mail; it never stores it.
import { createHash } from 'node:crypto';
import { parseInbound, RELAY_INBOUND_LIMITS } from '../apps/mock-inbox/inbound.mjs';
import { base64url, isDeviceSealed, keyIdFor, sealForDevice, sealTextForDevice, validPublicKey } from '../agent/device-seal.mjs';
import { currentText } from './jev-route.mjs';

export { isDeviceSealed, keyIdFor, validPublicKey };

const MAX_ATTACHMENTS = 5;

// The device a new message is sealed to: the thread's computer when it is
// still paired (an older computer without a key keeps relay-key sealing so it
// can run its thread), otherwise the account's newest computer with a key.
// Returns null when the message keeps relay-key sealing.
export async function sealTarget(db, accountId, threadId) {
  if (threadId) {
    const pinned = await db.prepare(`SELECT d.id, d.public_key, d.key_id FROM threads t
      JOIN devices d ON d.id = t.device_id
      WHERE t.id = ? AND t.account_id = ? AND d.revoked_at IS NULL`).bind(threadId, accountId).first();
    if (pinned) return pinned.public_key ? { deviceId: pinned.id, publicKey: pinned.public_key, keyId: pinned.key_id } : null;
  }
  return newestKeyedDevice(db, accountId);
}

export async function newestKeyedDevice(db, accountId, keyId = null) {
  const row = await db.prepare(`SELECT id, public_key, key_id FROM devices
    WHERE account_id = ? AND revoked_at IS NULL AND public_key IS NOT NULL AND (? IS NULL OR key_id = ?)
    ORDER BY key_registered_at DESC, rowid DESC LIMIT 1`).bind(accountId, keyId, keyId).first();
  return row ? { deviceId: row.id, publicKey: row.public_key, keyId: row.key_id } : null;
}

export async function registerDeviceKey(db, device, publicKey) {
  if (!validPublicKey(publicKey)) return null;
  const keyId = await keyIdFor(publicKey);
  await db.prepare(`UPDATE devices SET public_key = ?, key_id = ?, key_registered_at = CURRENT_TIMESTAMP
    WHERE id = ? AND account_id = ? AND revoked_at IS NULL AND (public_key IS NULL OR public_key != ?)`)
    .bind(publicKey, keyId, device.id, device.account_id, publicKey).run();
  return keyId;
}

export const sealedSubject = (target, subject) => sealTextForDevice(target.publicKey, subject, 'subject');

export function attachmentKey(objectKey, index) { return `${objectKey}.a${index}`; }

// Stores an inbound message sealed to the device: the parsed request (sender,
// subject, body, current text, attachment list) and one object per
// attachment. The raw MIME itself is not kept.
export async function storeSealedRequest(env, target, objectKey, message, agentAddress) {
  const parsed = await parseInbound(message.rawMime, agentAddress, {
    verifiedDeliveryToAgent: true, ...RELAY_INBOUND_LIMITS, includeAttachmentData: true,
  });
  if (parsed.messageId !== message.messageId || parsed.from !== message.from) throw new Error('Inbound mail changed while sealing');
  const attachments = parsed.attachments.slice(0, MAX_ATTACHMENTS);
  const request = { v: 1, from: parsed.from, subject: parsed.subject, body: parsed.body,
    text: currentText(parsed.body).trim(), messageId: parsed.messageId,
    attachments: attachments.map(({ name, mimeType, size, previewable }) => ({ name, mimeType, size, previewable })) };
  for (const [index, attachment] of attachments.entries()) {
    await env.MAIL.put(attachmentKey(objectKey, index),
      await sealForDevice(target.publicKey, Buffer.from(attachment.data, 'base64'), 'attachment'),
      { httpMetadata: { contentType: 'application/octet-stream' } });
  }
  await env.MAIL.put(objectKey, await sealForDevice(target.publicKey, JSON.stringify(request), 'request'),
    { httpMetadata: { contentType: 'application/octet-stream' } });
  return { attachmentCount: attachments.length };
}

export async function sealedObject(env, key) {
  const object = await env.MAIL.get(key);
  return object ? new Uint8Array(await object.arrayBuffer()) : null;
}

export async function sealedObjectText(env, key) {
  const bytes = await sealedObject(env, key);
  return bytes && isDeviceSealed(bytes) ? base64url(bytes) : null;
}

export async function storeSealedResult(env, publicKey, key, result) {
  await env.MAIL.put(key, await sealForDevice(publicKey, JSON.stringify(result), 'result'),
    { httpMetadata: { contentType: 'application/octet-stream' } });
}

// What the site may show about a result it can't read.
export function resultMeta(result) {
  const session = ['codex', 'claude'].includes(result?.session?.harness) &&
    /^[0-9a-f-]{36}$/i.test(result?.session?.id ?? '') ? { harness: result.session.harness, id: result.session.id } : null;
  return JSON.stringify({ state: result?.state ?? null, runtime: result?.runtime ?? null, ...(session ? { session } : {}) });
}

// A stored result: parsed JSON, { sealed: true } when only the device can open
// it, or null when it is missing or unreadable.
export async function readStoredResult(env, key) {
  if (!key) return null;
  const object = await env.MAIL.get(key);
  if (!object) return null;
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (isDeviceSealed(bytes)) return { sealed: true };
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { return null; }
}

// Outbound metadata keeps a salted hash of the subject so provider events can
// still be matched to their reply without keeping the subject itself.
export function subjectHash(jobId, subject) {
  return createHash('sha256').update(`${jobId}\n${subject}`).digest('hex');
}

export function payloadHash(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

// A rendered reply that must wait (an earlier reply in its thread is still in
// flight) is held sealed to the device, which opens it and posts it back when
// its turn comes (agent/device-key.mjs sendPendingReplies).
export async function sealHeldReply(publicKey, jobId, payload) {
  return sealForDevice(publicKey, JSON.stringify({ jobId, sealedAt: Date.now(), payload }), 'outbound');
}
