#!/usr/bin/env node
// This computer's sealing key. The private key never leaves this file (0600 in
// the TagMails config folder); the relay only knows the public key and stores
// mail, results and held replies sealed to it.
//
// CLI (run by the tagmails daemon):
//   device-key.mjs ensure <file>     create the key if missing; print {"publicKey"}
//   device-key.mjs generate <file>   replace the key (re-pairing); print {"publicKey"}
//   device-key.mjs open-claim        sealed claim JSON on stdin -> opened claim on stdout
//   device-key.mjs send-pending      open replies the relay held for this computer and post them back
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromBase64url, generateDeviceKey, openForDevice, validPublicKey } from './device-seal.mjs';

// The relay only asks this computer to open replies it rendered recently;
// anything older (or any other kind of sealed data) is refused, so the relay
// can't use this computer to read stored mail.
const OUTBOUND_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function readDeviceKey(file = process.env.TAGMAILS_DEVICE_KEY_FILE) {
  if (!file || !path.isAbsolute(file)) throw new Error('Device key file is missing');
  const stat = await fs.lstat(file);
  if (!stat.isFile()) throw new Error('Device key path is not a regular file');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('Device key file must be owner-only');
  const key = JSON.parse(await fs.readFile(file, 'utf8'));
  if (key?.version !== 1 || !validPublicKey(key.publicKey) || typeof key.privateKey !== 'string') throw new Error('Device key file is invalid');
  return key;
}

async function writeDeviceKey(file, replace) {
  if (!file || !path.isAbsolute(file)) throw new Error('Device key file must be an absolute path');
  const key = await generateDeviceKey();
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(key)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    if (replace) await fs.rename(temporary, file);
    else await fs.link(temporary, file); // Fails if another process created the key first.
  } finally { await fs.rm(temporary, { force: true }); }
  return key;
}

export async function ensureDeviceKey(file) {
  try { return await readDeviceKey(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try { return await writeDeviceKey(file, false); }
  catch (error) {
    if (error.code === 'EEXIST') return readDeviceKey(file);
    throw error;
  }
}

const opened = async (key, value, label) => openForDevice(key, fromBase64url(value), label);
const openedJson = async (key, value, label) => JSON.parse(new TextDecoder().decode(await opened(key, value, label)));

// Turns a claim whose request is sealed into the plain claim the adapters
// expect: subject, body (with any earlier unrun requests) and attachment links.
export async function openClaim(claim, key) {
  if (claim?.sealed !== true) return claim;
  const sealed = claim.request ?? {};
  const request = await openedJson(key, sealed.sealed, 'request');
  if (request.v !== 1 || typeof request.body !== 'string' || typeof request.subject !== 'string' ||
      request.from !== sealed.from || !Array.isArray(request.attachments)) throw new Error('Sealed request is invalid');
  const earlier = [];
  for (const item of Array.isArray(sealed.earlier) ? sealed.earlier : []) {
    if (typeof item?.text === 'string') { earlier.push({ from: item.from, text: item.text }); continue; }
    try {
      const opened = await openedJson(key, item.sealed, 'request');
      if (opened.from === item.from && opened.text) earlier.push({ from: item.from, text: opened.text });
    } catch { /* Skip one that no longer opens. */ }
  }
  const body = earlier.length ? `${earlier.map((item) =>
    `Earlier in this thread, ${item.from} wrote (the relay replied without running an agent):\n${item.text}`).join('\n\n')}\n\nThe current message:\n${request.body}` : request.body;
  const { sealed: _sealed, earlier: _earlier, ...plain } = sealed;
  return { ...claim, request: { ...plain, subject: request.subject, body,
    attachments: request.attachments.slice(0, 5).map((attachment, index) => ({
      name: attachment.name, mimeType: attachment.mimeType, size: attachment.size, previewable: attachment.previewable,
      sealed: true, path: `/api/device/attachment?jobId=${claim.jobId}&leaseId=${claim.leaseId}&index=${index}` })) } };
}

// A follow-up the relay holds sealed arrives as { id, from, sealed }.
export async function openSteer(steer, key) {
  if (typeof steer?.sealed !== 'string') return steer;
  const request = await openedJson(key, steer.sealed, 'request');
  if (request.from !== steer.from) throw new Error('Sealed follow-up sender does not match');
  return { id: steer.id, from: steer.from, text: request.text };
}

export async function openAttachment(bytes, key) {
  return Buffer.from(await openForDevice(key, bytes, 'attachment'));
}

async function relay(pathname, init = {}) {
  const base = process.env.TAGMAILS_RELAY_URL;
  const tokenFile = process.env.TAGMAILS_DEVICE_TOKEN_FILE;
  if (!base || !tokenFile) throw new Error('Relay settings are missing');
  const token = (await fs.readFile(tokenFile, 'utf8')).trim();
  const response = await fetch(new URL(pathname, base), { ...init, redirect: 'manual',
    headers: { ...init.headers, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120_000) });
  return response;
}

// Replies the relay could not send right away are held sealed to this
// computer. Open each (only "outbound" blobs for the job they name, younger
// than a week) and hand it back so the relay can send it.
export async function sendPendingReplies(key, { request = relay, now = Date.now } = {}) {
  let sent = 0;
  for (let round = 0; round < 10; round += 1) {
    const response = await request('/api/device/pending-sends');
    if (!response.ok) throw new Error(`Pending replies request failed (${response.status})`);
    const { replies = [] } = await response.json();
    if (!replies.length) break;
    let progressed = false;
    for (const reply of replies) {
      let held;
      try { held = await openedJson(key, reply.sealed, 'outbound'); }
      catch { continue; }
      if (held?.jobId !== reply.jobId || !Number.isSafeInteger(held.sealedAt) ||
          now() - held.sealedAt > OUTBOUND_MAX_AGE_MS || now() < held.sealedAt - 5 * 60_000 || !held.payload) continue;
      const posted = await request('/api/device/send', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: reply.jobId, payload: held.payload }) });
      if (posted.ok) { sent += 1; progressed = true; }
    }
    if (!progressed) break;
  }
  return sent;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main([command, file]) {
  if (command === 'ensure' || command === 'generate') {
    const key = command === 'ensure' ? await ensureDeviceKey(file) : await writeDeviceKey(file, true);
    process.stdout.write(`${JSON.stringify({ publicKey: key.publicKey })}\n`);
    return;
  }
  const key = await readDeviceKey();
  if (command === 'open-claim') {
    process.stdout.write(JSON.stringify(await openClaim(JSON.parse(await readStdin()), key)));
    return;
  }
  if (command === 'send-pending') {
    process.stdout.write(`${JSON.stringify({ sent: await sendPendingReplies(key) })}\n`);
    return;
  }
  throw new Error('Usage: device-key.mjs ensure|generate <file> | open-claim | send-pending');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`device-key: ${error.message}`);
    process.exit(1);
  });
}
