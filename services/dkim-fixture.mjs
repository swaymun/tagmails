// DKIM test helpers: sign a message the way a sending server would and serve its key.
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { _test } from './dkim.mjs';

// Signs a message the way a sending server would, with relaxed/relaxed rsa-sha256.
export function signed(raw, { domain = 'gmail.com', selector = 's1', privateKey, names = ['from', 'to', 'subject', 'message-id', 'content-type'], length }) {
  const { head, body } = _test.splitMessage(raw);
  const bh = createHash('sha256').update(_test.canonicalBody(body, 'relaxed', length)).digest('base64');
  const headerLines = head.split('\r\n').filter(Boolean);
  const pick = (name) => headerLines.findLast((line) => line.toLowerCase().startsWith(`${name}:`));
  const relaxed = (line) => { const at = line.indexOf(':'); return `${line.slice(0, at).trim().toLowerCase()}:${line.slice(at + 1).replace(/\s+/g, ' ').trim()}`; };
  const sigValue = ` v=1; a=rsa-sha256; c=relaxed/relaxed; d=${domain}; s=${selector}; h=${names.join(':')};${length == null ? '' : ` l=${length};`} bh=${bh}; b=`;
  // A listed header the message lacks signs as absent (how Gmail oversigns Cc).
  const data = names.filter(pick).map((name) => `${relaxed(pick(name))}\r\n`).join('') + relaxed(`DKIM-Signature:${sigValue}`);
  const b = createSign('RSA-SHA256').update(data, 'latin1').sign(privateKey, 'base64');
  return `DKIM-Signature:${sigValue}${b}\r\n${raw}`;
}

export function keyRecord() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const p = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { privateKey, resolveTxt: async () => [`v=DKIM1; k=rsa; p=${p}`] };
}

