import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import test from 'node:test';
import { stageAgentAttachments } from './agent-attachments.mjs';
import { ensureDeviceKey } from './device-key.mjs';
import { sealForDevice } from './device-seal.mjs';

test('local lab attachments are fetched into bounded temporary files', async (t) => {
  const bytes = Buffer.from('A small attached note.');
  const server = http.createServer((request, response) => {
    if (request.url !== '/api/attachment?messageId=mail-1&attachmentId=file-1') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain' }).end(bytes);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const previous = process.env.TAGMAILS_LAB_URL;
  process.env.TAGMAILS_LAB_URL = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    if (previous === undefined) delete process.env.TAGMAILS_LAB_URL;
    else process.env.TAGMAILS_LAB_URL = previous;
  });

  const staged = await stageAgentAttachments([{ name: 'note.txt', mimeType: 'text/plain',
    size: bytes.length, path: '/api/attachment?messageId=mail-1&attachmentId=file-1' }]);
  const file = `${staged.directory}/attachment-1.txt`;
  try {
    assert.deepEqual(await fs.readFile(file), bytes);
    assert.match(staged.prompt, /untrusted data/);
    assert.equal((await fs.stat(staged.directory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  } finally {
    await staged.cleanup();
  }
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  await assert.rejects(stageAgentAttachments([{ size: 3, mimeType: 'text/plain',
    path: '/api/attachment?messageId=mail-1&attachmentId=file-1' }]), /does not match/);
  await assert.rejects(stageAgentAttachments([{ size: 0, mimeType: 'text/plain',
    path: 'https://example.com/file' }]), /local lab/);
});

test('relay attachments use the device token and reject redirects and mismatched bytes', async (t) => {
  const token = `tm_dev_${'a'.repeat(43)}`;
  const scratch = await fs.mkdtemp(`${os.tmpdir()}/tagmails-attachment-test-`);
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const tokenFile = `${scratch}/device-token`;
  await fs.writeFile(tokenFile, token, { mode: 0o600 });
  const bytes = Buffer.from('private input');
  // Mail sealed to this computer arrives sealed and opens with its key file.
  const keyFile = `${scratch}/device-key`;
  const sealed = Buffer.from(await sealForDevice((await ensureDeviceKey(keyFile)).publicKey, bytes, 'attachment'));
  let downloads = 0;
  const server = http.createServer((request, response) => {
    downloads += 1;
    if (request.headers.authorization !== `Bearer ${token}`) return response.writeHead(401).end();
    if (request.url === '/api/device/attachment?jobId=job&leaseId=lease&index=0') {
      return response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(bytes);
    }
    if (request.url === '/api/device/attachment?jobId=job&leaseId=lease&index=1') {
      return response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(sealed);
    }
    return response.writeHead(302, { location: 'https://example.com/leak' }).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const old = { relay: process.env.TAGMAILS_RELAY_URL, token: process.env.TAGMAILS_DEVICE_TOKEN_FILE, key: process.env.TAGMAILS_DEVICE_KEY_FILE };
  process.env.TAGMAILS_RELAY_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.TAGMAILS_DEVICE_TOKEN_FILE = tokenFile;
  process.env.TAGMAILS_DEVICE_KEY_FILE = keyFile;
  t.after(() => {
    for (const [key, value] of Object.entries({ TAGMAILS_RELAY_URL: old.relay,
      TAGMAILS_DEVICE_TOKEN_FILE: old.token, TAGMAILS_DEVICE_KEY_FILE: old.key })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const attachment = { size: bytes.length, mimeType: 'text/plain',
    path: '/api/device/attachment?jobId=job&leaseId=lease&index=0' };
  const staged = await stageAgentAttachments([attachment], scratch);
  try { assert.deepEqual(await fs.readFile(`${staged.directory}/attachment-1.txt`), bytes); }
  finally { await staged.cleanup(); }
  assert.equal(downloads, 1);
  const sealedAttachment = { ...attachment, sealed: true, path: '/api/device/attachment?jobId=job&leaseId=lease&index=1' };
  const opened = await stageAgentAttachments([sealedAttachment], scratch);
  try { assert.deepEqual(await fs.readFile(`${opened.directory}/attachment-1.txt`), bytes); }
  finally { await opened.cleanup(); }
  // A claim that says sealed never takes unsealed bytes.
  await assert.rejects(stageAgentAttachments([{ ...attachment, sealed: true }], scratch));
  await assert.rejects(stageAgentAttachments([{ ...attachment, size: 1 }], scratch), /does not match/);
  await assert.rejects(stageAgentAttachments([{ ...attachment,
    path: '/api/device/attachment?jobId=redirect' }], scratch), /download failed/);
});

test('staged text PDFs expose bounded untrusted text and invalid PDFs stay unread', async () => {
  const pdf = await fs.readFile(new URL('../apps/mock-inbox/fixtures/vision-maple-83.pdf', import.meta.url));
  const staged = await stageAgentAttachments([{ data: pdf.toString('base64'), size: pdf.length,
    mimeType: 'application/pdf' }]);
  try {
    assert.match(staged.prompt, /Extracted PDF text \(untrusted/);
    assert.match(staged.prompt, /MAPLE 83/);
    assert.deepEqual(await fs.readFile(`${staged.directory}/attachment-1.pdf`), pdf);
  } finally { await staged.cleanup(); }

  const invalid = Buffer.from('not a PDF');
  const unread = await stageAgentAttachments([{ data: invalid.toString('base64'), size: invalid.length,
    mimeType: 'application/pdf' }]);
  try { assert.match(unread.prompt, /invalid PDF signature/); }
  finally { await unread.cleanup(); }
});

test('attachments staged in a Git workspace stay out of commits and keep their media type and name', async (t) => {
  const bytes = Buffer.from('not really a video');
  const server = http.createServer((request, response) => response.writeHead(200).end(bytes));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const previous = process.env.TAGMAILS_LAB_URL;
  process.env.TAGMAILS_LAB_URL = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { if (previous === undefined) delete process.env.TAGMAILS_LAB_URL; else process.env.TAGMAILS_LAB_URL = previous; });
  const root = await fs.realpath(await fs.mkdtemp(`${os.tmpdir()}/tagmails-git-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  git(root, 'init', '-q', 'repo');
  await fs.writeFile(`${root}/repo/.git/info/exclude`, '*.log');
  await fs.mkdir(`${root}/repo/app`);
  await fs.writeFile(`${root}/repo/app/readme.txt`, 'hi');
  git(`${root}/repo`, 'add', '.');
  git(`${root}/repo`, 'commit', '-qm', 'init');
  git(`${root}/repo`, 'worktree', 'add', '-q', `${root}/tree`);
  const attachment = { name: 'demo clip.mp4', mimeType: 'video/mp4', size: bytes.length,
    path: '/api/attachment?messageId=mail-1&attachmentId=file-1' };
  // The repository itself, a subfolder of it, and a linked worktree's subfolder.
  for (const workspace of [`${root}/repo`, `${root}/repo/app`, `${root}/tree/app`, `${root}/repo`]) {
    const staged = await stageAgentAttachments([attachment], workspace);
    assert.deepEqual(await fs.readFile(`${staged.directory}/attachment-1.mp4`), bytes);
    assert.match(staged.prompt, /video\/mp4, 18 bytes, sent as "demo clip\.mp4"/);
    assert.match(git(workspace, 'check-ignore', `${staged.directory}/attachment-1.mp4`), /attachment-1\.mp4/, workspace);
    assert.equal(git(workspace, 'status', '--porcelain'), '', `${workspace}: git add -A would not pick it up`);
    await staged.cleanup();
  }
  assert.equal(await fs.readFile(`${root}/repo/.git/info/exclude`, 'utf8'), '*.log\ntagmails-attachment-*/\n');
});
