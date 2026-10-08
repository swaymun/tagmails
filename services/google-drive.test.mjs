import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { bindings } from './bindings-fixture.mjs';
import { connectDrive, disconnectDrive, DRIVE_SCOPE, DriveNotConnected, recordDriveFile, startDriveUpload } from './google-drive.mjs';

const KEY = randomBytes(32).toString('base64');

// A fake Google: token endpoint, Drive folder/file metadata and resumable sessions.
function google({ scope = DRIVE_SCOPE, revoked = false } = {}) {
  const calls = [];
  const files = new Map();
  const fetcher = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const u = new URL(url);
    if (u.pathname === '/token') {
      const form = new URLSearchParams(init.body);
      if (form.get('grant_type') === 'authorization_code') {
        return Response.json({ access_token: 'at', refresh_token: 'rt-secret', scope: `openid ${scope}` });
      }
      return revoked ? Response.json({ error: 'invalid_grant' }, { status: 400 }) : Response.json({ access_token: 'at' });
    }
    if (u.pathname === '/revoke') return new Response('');
    if (u.pathname === '/drive/v3/files' && init.method === 'POST') {
      files.set('folder123456', { id: 'folder123456', trashed: false });
      return Response.json({ id: 'folder123456' });
    }
    if (u.pathname.startsWith('/drive/v3/files/')) {
      const file = files.get(u.pathname.split('/').pop());
      return file ? Response.json(file) : Response.json({}, { status: 404 });
    }
    if (u.pathname === '/upload/drive/v3/files') {
      const meta = JSON.parse(init.body);
      files.set('file12345678', { id: 'file12345678', name: meta.name, size: init.headers['X-Upload-Content-Length'],
        parents: meta.parents, webViewLink: 'https://drive.google.com/file/d/file12345678/view', trashed: false });
      return new Response(null, { headers: { location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=xyz' } });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { fetcher, calls, files };
}

test('connecting Drive stores a sealed refresh token and needs the drive.file grant', async () => {
  const { env, sqlite } = bindings();
  Object.assign(env, { STORAGE_KEY: KEY, GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' });
  await assert.rejects(connectDrive(env, 'account-1', 'code', google({ scope: 'email' }).fetcher), /not granted/);
  await connectDrive(env, 'account-1', 'code', google().fetcher);
  const stored = sqlite.prepare('SELECT refresh_token FROM drive_connections').get().refresh_token;
  assert.ok(!stored.includes('rt-secret'));
  await disconnectDrive(env, 'account-1', google().fetcher);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM drive_connections').get().n, 0);
});

test('an upload goes into the TagMails folder and is recorded only if Google has it at that size', async () => {
  const { env, sqlite } = bindings();
  Object.assign(env, { STORAGE_KEY: KEY, GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' });
  const fake = google();
  await assert.rejects(startDriveUpload(env, 'account-1', { name: 'a.pdf', mimeType: 'application/pdf', size: 5 }, fake.fetcher), DriveNotConnected);
  await connectDrive(env, 'account-1', 'code', fake.fetcher);
  const url = await startDriveUpload(env, 'account-1', { name: 'tokyo.pdf', mimeType: 'application/pdf', size: 65364035 }, fake.fetcher);
  assert.match(url, /^https:\/\/www\.googleapis\.com\/upload/);
  assert.equal(sqlite.prepare('SELECT folder_id FROM drive_connections').get().folder_id, 'folder123456');
  sqlite.prepare("INSERT INTO threads (id, account_id, subject) VALUES ('t', 'account-1', 's')").run();
  sqlite.prepare("INSERT INTO messages (id, account_id, thread_id, message_id, direction, sender_email, object_key) VALUES ('m', 'account-1', 't', '<m@x>', 'inbound', 'owner@gmail.com', 'k')").run();
  sqlite.prepare("INSERT INTO jobs (id, thread_id, message_id, state) VALUES ('job', 't', 'm', 'running')").run();
  await assert.rejects(recordDriveFile(env, 'account-1', 'job', 'file12345678', 10, fake.fetcher), /did not match/);
  const file = await recordDriveFile(env, 'account-1', 'job', 'file12345678', 65364035, fake.fetcher);
  assert.equal(file.name, 'tokyo.pdf');
  assert.equal(sqlite.prepare('SELECT byte_size FROM drive_files').get().byte_size, 65364035);
});

test('a revoked grant is forgotten so the owner is asked to reconnect', async () => {
  const { env, sqlite } = bindings();
  Object.assign(env, { STORAGE_KEY: KEY, GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' });
  await connectDrive(env, 'account-1', 'code', google().fetcher);
  await assert.rejects(startDriveUpload(env, 'account-1', { name: 'a.pdf', mimeType: 'application/pdf', size: 5 }, google({ revoked: true }).fetcher), DriveNotConnected);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM drive_connections').get().n, 0);
});
