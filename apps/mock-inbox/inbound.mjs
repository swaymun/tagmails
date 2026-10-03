import PostalMime from 'postal-mime';
import { convert } from 'html-to-text';

const MAX_RAW_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 3 * 1024 * 1024;
export const RELAY_INBOUND_LIMITS = Object.freeze({
  maxRawBytes: 38_000_000,
  maxAttachmentBytes: 24_000_000,
  maxTotalAttachmentBytes: 25_000_000,
});
const MESSAGE_IDS = /<[^<>\s]+@[^<>\s]+>/g;

function addresses(items) {
  return (items ?? []).flatMap((item) => item.group ? item.group.map((member) => member.address) : [item.address]).map((address) => address?.toLowerCase()).filter(Boolean);
}

function previewable(mimeType, bytes) {
  if (mimeType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === 'image/jpeg') return bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  if (mimeType === 'image/gif') return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
  if (mimeType === 'image/webp') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

export async function parseInbound(raw, agentAddress = 'agent@wonder.test', {
  verifiedDeliveryToAgent = false,
  maxRawBytes = MAX_RAW_BYTES,
  maxAttachmentBytes = MAX_ATTACHMENT_BYTES,
  maxTotalAttachmentBytes = MAX_TOTAL_ATTACHMENT_BYTES,
  includeAttachmentData = true,
  attachmentBytesAt = -1,
} = {}) {
  const source = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (!source.length || source.length > maxRawBytes) throw new Error(`The .eml file must be between 1 byte and ${maxRawBytes === MAX_RAW_BYTES ? '5 MB' : `${maxRawBytes} bytes`}`);
  const email = await PostalMime.parse(source, {
    maxNestingDepth: 30,
    maxHeadersSize: 64 * 1024,
    maxRfc822NestingDepth: 0,
  });
  const from = email.from?.group ? null : email.from?.address?.toLowerCase();
  if (!from) throw new Error('The email needs one sender mailbox');
  const to = addresses(email.to);
  const cc = addresses(email.cc);
  const bcc = addresses(email.bcc);
  if (!verifiedDeliveryToAgent && ![...to, ...cc, ...bcc].includes(agentAddress)) throw new Error(`The email must include ${agentAddress} as a recipient`);
  if (!email.messageId || !/^<[^<>\s]+@[^<>\s]+>$/.test(email.messageId)) throw new Error('The email needs a valid Message-ID');
  const autoSubmitted = email.headers.find((header) => header.key === 'auto-submitted')?.value?.toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') throw new Error('Automatic response email was ignored');
  const reactionParts = email.attachments.filter((part) => part.mimeType === 'text/vnd.google.email-reaction+json');
  if (reactionParts.length) {
    if (reactionParts.length !== 1 || email.attachments.length !== 1 || reactionParts[0].disposition === 'attachment' || reactionParts[0].content.length > 1024) throw new Error('Invalid Gmail reaction');
    let reaction;
    try { reaction = JSON.parse(Buffer.from(reactionParts[0].content).toString('utf8')); }
    catch { throw new Error('Invalid Gmail reaction'); }
    const emoji = reaction?.emoji;
    const oneEmoji = typeof emoji === 'string' && [...new Intl.Segmenter().segment(emoji)].length === 1 && /\p{Extended_Pictographic}|\p{Emoji_Presentation}|\uFE0F/u.test(emoji);
    const targetId = String(email.inReplyTo || '').trim();
    if (reaction?.version !== 1 || !oneEmoji || !/^<[^<>\s]+@[^<>\s]+>$/.test(targetId)) throw new Error('Invalid Gmail reaction');
    return { from, messageId: email.messageId, reaction: emoji, reactionTargetId: targetId };
  }
  const body = (email.text?.trim() || (email.html ? convert(email.html, { wordwrap: false }).trim() : ''));
  if (!body) throw new Error('The email has no readable text');
  if (email.attachments.length > MAX_ATTACHMENTS) throw new Error('The email has too many attachments for this lab');
  const directParents = [...String(email.inReplyTo || '').matchAll(MESSAGE_IDS)].map((match) => match[0]);
  const directSet = new Set(directParents);
  const parentIds = [...new Set([
    ...[...String(email.references || '').matchAll(MESSAGE_IDS)].map((match) => match[0])
      .filter((id) => !directSet.has(id)),
    ...directParents,
  ])];

  let total = 0;
  const attachments = email.attachments.map((attachment, index) => {
    if (attachment.rfc822DepthExceeded) throw new Error('Nested email attachments are not supported in this lab');
    const bytes = Buffer.from(attachment.content);
    total += bytes.length;
    if (bytes.length > maxAttachmentBytes || total > maxTotalAttachmentBytes) throw new Error('The email attachments exceed the configured limit');
    const name = String(attachment.filename || `attachment-${index + 1}`).split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120) || `attachment-${index + 1}`;
    const mimeType = String(attachment.mimeType || 'application/octet-stream').toLowerCase();
    return { name, mimeType, size: bytes.length,
      ...(includeAttachmentData ? { data: bytes.toString('base64') } : {}),
      ...(index === attachmentBytesAt ? { bytes } : {}),
      previewable: previewable(mimeType, bytes) };
  });

  return {
    from,
    to,
    cc,
    bcc,
    subject: email.subject || '(no subject)',
    body,
    messageId: email.messageId,
    parentIds,
    attachments,
  };
}
