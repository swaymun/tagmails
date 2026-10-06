import { createHash } from 'node:crypto';
import { escapeHtml, renderMarkdown } from './markdown.mjs';

export { escapeHtml };

const CRLF = '\r\n';
export const EMAIL_FORMAT_VERSION = 5;

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

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

// The answer leads the email. Status, model, credits and links sit in one
// quiet footer line; there is no heading or card chrome.
export function renderResult(result) {
  const answer = typeof result.answer === 'string' && result.answer.trim()
    ? result.answer.trim()
    : [result.summary, ...(result.details ?? [])].filter(Boolean).join('\n\n');
  const note = typeof result.note === 'string' && result.note.trim() ? result.note.trim() : null;
  const status = result.statusLine || ({ failed: 'Stopped',
    needs_approval: 'Needs approval' }[result.state] ?? null);
  // Footer links may also open the owner's session straight in Codex or Claude.
  const appUrl = (url) => typeof url === 'string' &&
    /^(codex:\/\/threads\/|claude:\/\/resume\?session=)[0-9a-f-]{36}$/.test(url) ? url : null;
  const safeLinks = (result.links ?? []).map(({ label, url }) => ({ label, url: safeUrl(url) ?? appUrl(url) }))
    .filter(({ url }) => url);
  const linkStyle = 'color:#1f5c41;text-decoration:underline';
  const links = safeLinks.map(({ label, url }) =>
    `<a href="${escapeHtml(url)}" style="${linkStyle}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`);
  const brandUrl = safeUrl(result.brandUrl);
  const brand = brandUrl ? `<a class="brand" href="${escapeHtml(brandUrl)}" target="_blank" rel="noopener noreferrer" aria-label="TagMails website" style="color:#1d2420;font-weight:600;text-decoration:none"><span class="mark" aria-hidden="true" style="display:inline-block;background:#1d2420;color:#d0f06c;border-radius:4px;padding:0 4px;margin-right:3px;font-size:11px;line-height:16px">↗</span>tagmails<span style="color:#7aa33a">.</span></a>` : '';
  const footerItems = [...links, status ? `<span style="color:#1d2420">${escapeHtml(status)}</span>` : null,
    ...(result.meta ?? []).map((item) => `<span>${escapeHtml(item)}</span>`), brand].filter(Boolean);
  const footerHtml = footerItems.map((item, index) =>
    `${index ? '<span aria-hidden="true" style="color:#b3bab5;padding:0 6px">·</span>' : ''}<span style="white-space:nowrap">${item}</span>`).join('');
  const bodyNotes = [...(result.checks ?? []), ...(note && result.state === 'completed' ? [note] : [])];
  const showNotes = bodyNotes.length && (result.preview || !safeLinks.length);
  const noticeStyle = 'margin:0 0 12px;color:#7a5a2c;font-size:14px';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="margin:0;padding:0"><div style="font:15px/1.55 ${FONT};color:#1d2420;max-width:640px;word-wrap:break-word">${
    result.preview ? `<p style="${noticeStyle}">Synthetic preview</p>` : ''}${renderMarkdown(answer)}${
    note && result.state !== 'completed' ? `<p style="${noticeStyle}">${escapeHtml(note)}</p>` : ''}${
    showNotes ? `<p style="${noticeStyle}">${escapeHtml(bodyNotes.join(' '))}</p>` : ''}${
    footerHtml ? `<footer style="margin-top:22px;padding-top:9px;border-top:1px solid #e6e8e4;color:#6f7a73;font-size:12px;line-height:1.8">${footerHtml}</footer>` : ''}</div></body></html>`;
  const text = [...(result.preview ? ['Synthetic preview', ''] : []), answer,
    ...(note && result.state !== 'completed' ? ['', note] : []),
    ...(bodyNotes.length ? ['', ...bodyNotes] : []), '', '—',
    [...safeLinks.map(({ label, url }) => `${label}: ${url}`), status, ...(result.meta ?? []),
      brandUrl ? `TagMails: ${brandUrl}` : null]
      .filter(Boolean).join(' · ')].join('\n');
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
