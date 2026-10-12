// DKIM verification (RFC 6376) for mail received directly by the Worker.
// Cloudflare Email Routing hands us raw mail without a usable authentication
// verdict, so the relay only trusts a sender when a signature from the From
// domain (or its parent) verifies. rsa-sha256 with simple/relaxed
// canonicalization, which covers Gmail, Google Workspace and Outlook.

const encoder = new TextEncoder();

function splitMessage(raw) {
  const text = typeof raw === 'string' ? raw : new TextDecoder('latin1').decode(raw);
  const normalized = /(^|[^\r])\n/.test(text) ? text.replace(/\r?\n/g, '\r\n') : text;
  const index = normalized.indexOf('\r\n\r\n');
  return index < 0 ? { head: normalized, body: '' } : { head: normalized.slice(0, index + 2), body: normalized.slice(index + 4) };
}

export function parseHeaders(head) {
  const headers = [];
  for (const line of head.split('\r\n')) {
    if (!line) continue;
    if (/^[ \t]/.test(line) && headers.length) headers.at(-1).raw += `\r\n${line}`;
    else headers.push({ raw: line });
  }
  for (const header of headers) {
    const colon = header.raw.indexOf(':');
    header.name = header.raw.slice(0, colon).trim().toLowerCase();
    header.value = header.raw.slice(colon + 1);
  }
  return headers;
}

function tags(value) {
  const out = {};
  for (const part of value.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    out[part.slice(0, at).trim()] = part.slice(at + 1).replace(/\s+/g, '');
  }
  return out;
}

function canonicalBody(body, mode, length) {
  let text = body;
  if (mode === 'relaxed') {
    text = text.split('\r\n').map((line) => line.replace(/[ \t]+/g, ' ').replace(/ +$/, '')).join('\r\n');
    text = text.replace(/(\r\n)*$/, '');
    text = text ? `${text}\r\n` : '';
  } else {
    text = text.replace(/(\r\n)*$/, '\r\n');
  }
  const bytes = bytesOf(text);
  return length == null ? bytes : bytes.subarray(0, length);
}

function canonicalHeader(header, mode) {
  if (mode === 'relaxed') {
    const value = header.value.replace(/\r\n/g, '').replace(/[ \t]+/g, ' ').trim();
    return `${header.name}:${value}`;
  }
  return header.raw;
}

// The text was decoded as latin1, so each character is one byte. Never spread
// it into an array: a 25 MB email would become 25 million array slots.
function bytesOf(text) {
  return Buffer.from(text, 'latin1');
}

function decodeBase64(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

export async function dohTxt(name, fetcher = fetch) {
  const response = await fetcher(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`,
    { headers: { accept: 'application/dns-json' } });
  if (!response.ok) throw new Error(`DNS lookup failed for ${name}`);
  const data = await response.json();
  return (data.Answer ?? []).filter((answer) => answer.type === 16)
    .map((answer) => answer.data.replace(/^"|"$/g, '').replace(/"\s*"/g, ''));
}

async function verifySignature(signatureHeader, headers, body, resolveTxt) {
  const t = tags(signatureHeader.value);
  const result = { domain: (t.d ?? '').toLowerCase(), selector: t.s ?? '', pass: false,
    signedHeaders: (t.h ?? '').toLowerCase().split(':').map((item) => item.trim()).filter(Boolean) };
  if (t.v !== '1' || t.a !== 'rsa-sha256' || !t.d || !t.s || !t.b || !t.bh || !t.h) return { ...result, reason: 'unsupported signature' };
  if (t.x && Number(t.x) * 1000 < Date.now()) return { ...result, reason: 'expired' };
  // RFC 6376 requires From to be signed; without it the signature says nothing about the sender.
  if (!t.h.toLowerCase().split(':').map((item) => item.trim()).includes('from')) return { ...result, reason: 'from not signed' };
  const [headerMode, bodyMode = 'simple'] = (t.c ?? 'simple/simple').split('/');
  const fullBody = canonicalBody(body, bodyMode, null);
  // l= signs only a prefix, so anyone could append instructions after it.
  if (t.l != null && !(Number(t.l) >= fullBody.length)) return { ...result, reason: 'partial body signature' };
  const bodyHash = new Uint8Array(await crypto.subtle.digest('SHA-256', fullBody));
  const expected = decodeBase64(t.bh);
  if (bodyHash.length !== expected.length || bodyHash.some((byte, index) => byte !== expected[index])) {
    return { ...result, reason: 'body hash mismatch' };
  }
  // Each listed name consumes that header's occurrences from the bottom up.
  const used = new Map();
  const lines = [];
  for (const name of t.h.toLowerCase().split(':').map((item) => item.trim()).filter(Boolean)) {
    const matches = headers.filter((header) => header.name === name);
    const seen = used.get(name) ?? 0;
    const header = matches[matches.length - 1 - seen];
    used.set(name, seen + 1);
    if (header) lines.push(`${canonicalHeader(header, headerMode)}\r\n`);
  }
  const unsigned = { ...signatureHeader, raw: signatureHeader.raw.replace(/(\bb=)[^;]*/, '$1'), value: signatureHeader.value.replace(/(\bb=)[^;]*/, '$1') };
  lines.push(canonicalHeader(unsigned, headerMode));
  const records = await resolveTxt(`${t.s}._domainkey.${t.d}`);
  const record = records.map(tags).find((item) => item.p);
  if (!record || (record.k && record.k !== 'rsa')) return { ...result, reason: 'no key' };
  try {
    const key = await crypto.subtle.importKey('spki', decodeBase64(record.p),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decodeBase64(t.b), bytesOf(lines.join('')));
    return { ...result, pass: ok, reason: ok ? 'pass' : 'bad signature' };
  } catch { return { ...result, reason: 'bad key' }; }
}

export function aligned(signingDomain, fromDomain) {
  const d = signingDomain.toLowerCase();
  const from = fromDomain.toLowerCase();
  return d === from || from.endsWith(`.${d}`);
}

// Headers that decide who gets access (To, Cc), which thread and whether it is
// a replay (Message-ID, References, In-Reply-To) and how the body is read
// (Content-Type, Content-Transfer-Encoding; Gmail sends neither unsigned:
// its mail is multipart with no top-level encoding). A valid signature that leaves one of them unsigned would let
// whoever holds a copy add a Cc or re-frame the MIME. Gmail signs all of them.
export const MUST_SIGN = ['to', 'cc', 'subject', 'message-id', 'references', 'in-reply-to', 'content-type',
  'content-transfer-encoding'];

/**
 * Returns { pass, domain, signedHeaders } when a signature from the From domain
 * verifies and covers every header in MUST_SIGN that the message has.
 */
export async function verifyDkim(raw, fromAddress, { resolveTxt = (name) => dohTxt(name) } = {}) {
  const { head, body } = splitMessage(raw);
  const headers = parseHeaders(head);
  const fromDomain = String(fromAddress ?? '').split('@').pop().toLowerCase();
  // Two From headers make "who signed" and "who it's from" ambiguous between
  // parsers; the same goes for To and Cc, which decide who the mail was for.
  if (headers.filter((header) => header.name === 'from').length !== 1 ||
      ['to', 'cc'].some((name) => headers.filter((header) => header.name === name).length > 1)) return { pass: false, results: [] };
  const signatures = headers.filter((header) => header.name === 'dkim-signature').slice(0, 5);
  const results = [];
  for (const signature of signatures) {
    const result = await verifySignature(signature, headers, body, resolveTxt);
    results.push(result);
    const uncovered = MUST_SIGN.filter((name) => headers.some((header) => header.name === name) && !result.signedHeaders.includes(name));
    if (result.pass && uncovered.length) result.reason = `unsigned ${uncovered.join(', ')}`;
    else if (result.pass && aligned(result.domain, fromDomain)) {
      return { pass: true, domain: result.domain, signedHeaders: result.signedHeaders, results };
    }
  }
  return { pass: false, results };
}

export const _test = { canonicalBody, canonicalHeader, splitMessage, encoder };

/**
 * The relay's whole sender check for raw inbound mail: an aligned signature
 * from the From domain that covers MUST_SIGN, with the agent in a signed To or
 * Cc. Otherwise any mail the owner sent elsewhere could be re-sent to the
 * agent and pass, so Bcc to the agent is not supported.
 * Returns { pass: true } or { pass: false, reason }.
 */
export async function authenticateSender(raw, { from, to = [], cc = [] }, agent, options = {}) {
  const dkim = await verifyDkim(raw, from, options);
  if (!dkim.pass) return { pass: false, reason: 'sender authentication failed' };
  const signedTo = dkim.signedHeaders.includes('to') && to.includes(agent);
  const signedCc = dkim.signedHeaders.includes('cc') && cc.includes(agent);
  return signedTo || signedCc ? { pass: true } : { pass: false, reason: 'agent not in signed To or Cc' };
}
