import { createHash } from 'node:crypto';

const CRLF = '\r\n';

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

export function safeUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value, 'http://127.0.0.1');
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (value.startsWith('/') && !value.startsWith('//')) return value;
    if (url.protocol === 'https:') return url.href;
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1') return url.href;
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
  const title = result.state === 'failed' ? 'Could not finish' : result.state === 'needs_approval' ? 'Waiting for approval' : result.state === 'needs_clarification' ? 'Which model should I use?' : 'Task completed';
  const items = (result.details ?? []).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  const checks = (result.checks ?? []).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  const links = (result.links ?? []).map(({ label, url }) => {
    const href = safeUrl(url);
    return href ? `<li><a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a></li>` : '';
  }).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>body{font:16px/1.55 Arial,sans-serif;color:#252a33;max-width:640px;margin:0 auto;padding:24px}h1{font-size:22px;line-height:1.2;margin:0 0 18px}h2{font-size:14px;margin:24px 0 6px}p,ul{margin:0 0 14px}a{color:#164db1;text-underline-offset:2px}.note{background:#f3f6fa;padding:12px 14px;border-radius:8px;color:#454d59}.foot{border-top:1px solid #dae0e9;padding-top:16px;margin-top:24px;color:#52606d;font-size:14px}</style></head><body><h1>${title}</h1><p>${escapeHtml(result.summary)}</p>${items ? `<h2>What happened</h2><ul>${items}</ul>` : ''}${checks ? `<h2>Checks and limits</h2><ul>${checks}</ul>` : ''}${links ? `<h2>Open</h2><ul>${links}</ul>` : ''}<p class="note">${escapeHtml(result.note)}</p><p class="foot">Reply to this email to continue the same task.</p></body></html>`;
  const text = [title, '', result.summary, '', ...(result.details?.length ? ['What happened', ...result.details.map((item) => `- ${item}`), ''] : []), ...(result.checks?.length ? ['Checks and limits', ...result.checks.map((item) => `- ${item}`), ''] : []), ...(result.links?.length ? ['Open', ...result.links.filter(({ url }) => safeUrl(url)).map(({ label, url }) => `${label}: ${safeUrl(url)}`), ''] : []), result.note, '', 'Reply to this email to continue the same task.'].join('\n');
  return { html, text };
}

export function makeMime({ from, to, subject, messageId, inReplyTo, references = [], text, html }) {
  const boundary = `wonder-email-${createHash('sha256').update(messageId).digest('hex').slice(0, 20)}`;
  const headers = [
    `From: ${header(from)}`,
    `To: ${header(to)}`,
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
