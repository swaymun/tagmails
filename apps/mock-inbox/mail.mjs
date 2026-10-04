import { createHash } from 'node:crypto';

const CRLF = '\r\n';
export const EMAIL_FORMAT_VERSION = 2;

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

export function safeUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (url.protocol === 'https:') return url.href;
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port) return url.href;
  } catch { /* Invalid links are omitted from outgoing mail. */ }
  return null;
}

function header(value) {
  const text = String(value ?? '');
  if (/[\r\n]/.test(text)) throw new Error('Email header contains a line break');
  return text;
}

function encodedSubject(value) {
  const subject = header(value);
  return /^[\x20-\x7e]*$/.test(subject)
    ? subject
    : `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
}

function base64Lines(value) {
  return Buffer.from(value, 'utf8').toString('base64').match(/.{1,76}/g)?.join(CRLF) ?? '';
}

export function renderResult(result) {
  const title = result.preview ? 'Synthetic preview' : result.state === 'failed' ? 'Could not finish' : result.state === 'needs_approval' ? 'Needs your attention' : result.state === 'needs_clarification' ? 'Which model should I use?' : 'Agent reply';
  const note = typeof result.note === 'string' && result.note.trim() ? result.note.trim() : null;
  const status = result.statusLine || ({ completed: 'Completed', failed: 'Could not finish',
    needs_approval: 'Needs attention', needs_clarification: 'Waiting for your reply' }[result.state] ?? 'Preview');
  const detailHtml = (result.details ?? []).map((item) => `<p class="detail">${escapeHtml(item).replace(/\n/g, '<br>')}</p>`).join('');
  const footerDetails = [...(result.meta ?? []), ...(result.checks ?? []),
    ...(note && result.state === 'completed' ? [note] : [])];
  const safeLinks = (result.links ?? []).map(({ label, url }) => ({ label, url: safeUrl(url) }))
    .filter(({ url }) => url);
  const links = safeLinks.map(({ label, url }) =>
    `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`).join(' <span aria-hidden="true">·</span> ');
  const brandUrl = safeUrl(result.brandUrl);
  const brand = brandUrl ? `<a class="brand" href="${escapeHtml(brandUrl)}" target="_blank" rel="noopener noreferrer"><span class="mark" aria-hidden="true">↗</span> tagmails<span class="dot">.</span></a>` : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>body{font:16px/1.5 Arial,sans-serif;color:#172620;max-width:640px;margin:0 auto;padding:22px}h1{font-size:21px;line-height:1.25;margin:0 0 14px}p{margin:0 0 13px}.detail{white-space:pre-wrap}.notice{color:#5b3412}.foot{border-top:1px solid #dce4df;margin-top:26px;padding-top:14px;color:#4a5b51;font-size:13px;line-height:1.5}.status{font-weight:700;color:#172620;margin:0 0 8px}.meta{margin:0 0 5px}.links{margin:10px 0}.brand{display:inline-block;color:#172620;font-weight:700;text-decoration:none}.mark{display:inline-block;background:#172620;color:#d0f06c;border-radius:6px;padding:1px 7px;margin-right:5px;font-size:18px;line-height:1.35}.dot{color:#729323}.reply{margin-top:12px}a{color:#235b43;text-decoration:underline;text-underline-offset:2px}</style></head><body><h1>${title}</h1><p>${escapeHtml(result.summary)}</p>${detailHtml}${note && result.state !== 'completed' ? `<p class="notice">${escapeHtml(note)}</p>` : ''}<footer class="foot"><p class="status">${escapeHtml(status)}</p>${footerDetails.map((item) => `<p class="meta">${escapeHtml(item)}</p>`).join('')}${links ? `<p class="links">${links}</p>` : ''}${brand ? `<p>${brand}</p>` : ''}<p class="reply">Reply to this email to continue the same task.</p></footer></body></html>`;
  const text = [title, '', result.summary, ...(result.details?.length ? ['', ...result.details] : []),
    ...(note && result.state !== 'completed' ? ['', note] : []), '', status, ...footerDetails,
    ...safeLinks.map(({ label, url }) => `${label}: ${url}`),
    ...(brandUrl ? [`TagMails: ${brandUrl}`] : []),
    'Reply to this email to continue the same task.'].join('\n');
  return { html, text };
}

export function makeMime({ from, to, cc = [], subject, messageId, inReplyTo, references = [], text, html }) {
  const boundary = `wonder-email-${createHash('sha256').update(messageId).digest('hex').slice(0, 20)}`;
  const headers = [
    `From: ${header(from)}`,
    `To: ${header(to)}`,
    ...(cc.length ? [`Cc: ${cc.map(header).join(', ')}`] : []),
    `Subject: ${encodedSubject(subject)}`,
    `Message-ID: ${header(messageId)}`,
    `Date: ${new Date().toUTCString()}`,
    ...(inReplyTo ? [`In-Reply-To: ${header(inReplyTo)}`] : []),
    ...(references.length ? [`References: ${references.map(header).join(' ')}`] : []),
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  return [
    ...headers, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', base64Lines(text),
    `--${boundary}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', base64Lines(html),
    `--${boundary}--`, '',
  ].join(CRLF);
}

// The lab decodes only MIME created by makeMime. Provider inbound parsing is a separate boundary.
export function readGeneratedMime(raw) {
  const boundary = raw.match(/boundary="([^"\r\n]+)"/)?.[1];
  if (!boundary) throw new Error('Generated email has no multipart boundary');
  const parts = raw.split(`--${boundary}`).slice(1, -1);
  const output = {};
  for (const part of parts) {
    const [partHeaders, encoded] = part.replace(/^\r\n/, '').split('\r\n\r\n');
    const kind = partHeaders?.match(/Content-Type: (text\/(?:plain|html))/i)?.[1];
    if (kind && encoded) output[kind] = Buffer.from(encoded.replace(/\s/g, ''), 'base64').toString('utf8');
  }
  if (!output['text/plain'] || !output['text/html']) throw new Error('Generated email is missing a MIME part');
  return { text: output['text/plain'], html: output['text/html'] };
}
