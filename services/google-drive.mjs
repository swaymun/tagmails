// Google Drive for large run files. The owner grants drive.file (TagMails can
// see only files it created). The relay keeps the sealed refresh token and
// opens a resumable upload session; the Mac sends the bytes straight to Google.
import { openText, sealText } from './storage-crypto.mjs';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER = 'application/vnd.google-apps.folder';
export const DRIVE_FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;
export const MAX_DRIVE_FILE_BYTES = 2_000_000_000;

export class DriveNotConnected extends Error {}

export async function connectDrive(env, accountId, code, fetcher = fetch) {
  if (!env.GOOGLE_CLIENT_SECRET || typeof code !== 'string' || !code || code.length > 2000) throw new Error('Invalid Google code');
  const response = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: 'postmessage', grant_type: 'authorization_code' }),
  });
  const grant = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('Google did not accept the Drive grant');
  if (!String(grant.scope ?? '').split(' ').includes(DRIVE_SCOPE)) throw new Error('Drive access was not granted');
  if (typeof grant.refresh_token !== 'string') throw new Error('Google returned no refresh token; remove TagMails in your Google account permissions and connect again');
  await env.DB.prepare(`INSERT INTO drive_connections (account_id, refresh_token) VALUES (?, ?)
    ON CONFLICT(account_id) DO UPDATE SET refresh_token = excluded.refresh_token`)
    .bind(accountId, await sealText(env, grant.refresh_token)).run();
}

export async function driveConnected(env, accountId) {
  return Boolean(await env.DB.prepare('SELECT 1 FROM drive_connections WHERE account_id = ?').bind(accountId).first());
}

export async function disconnectDrive(env, accountId, fetcher = fetch) {
  const row = await env.DB.prepare('SELECT refresh_token FROM drive_connections WHERE account_id = ?').bind(accountId).first();
  if (!row) return;
  await fetcher(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(await openText(env, row.refresh_token))}`,
    { method: 'POST' }).catch(() => {});
  await env.DB.prepare('DELETE FROM drive_connections WHERE account_id = ?').bind(accountId).run();
}

async function accessToken(env, accountId, fetcher) {
  const row = await env.DB.prepare('SELECT refresh_token, folder_id FROM drive_connections WHERE account_id = ?').bind(accountId).first();
  if (!row) throw new DriveNotConnected();
  const response = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: await openText(env, row.refresh_token), grant_type: 'refresh_token' }),
  });
  const grant = await response.json().catch(() => ({}));
  if (grant.error === 'invalid_grant') {
    // Revoked in the Google account: forget it so the owner is asked to reconnect.
    await env.DB.prepare('DELETE FROM drive_connections WHERE account_id = ?').bind(accountId).run();
    throw new DriveNotConnected();
  }
  if (!response.ok || typeof grant.access_token !== 'string') throw new Error('Google Drive is unavailable right now');
  return { token: grant.access_token, folderId: row.folder_id };
}

async function driveJson(fetcher, token, url, init = {}) {
  const response = await fetcher(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

// A "TagMails" folder in My Drive, recreated if the owner trashed or deleted it.
async function folder(env, accountId, token, folderId, fetcher) {
  if (folderId) {
    const found = await driveJson(fetcher, token, `https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,trashed`);
    if (found.ok && !found.body.trashed) return folderId;
  }
  const created = await driveJson(fetcher, token, 'https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'TagMails', mimeType: FOLDER }),
  });
  if (!created.ok || !DRIVE_FILE_ID.test(created.body.id ?? '')) throw new Error('Could not create the TagMails Drive folder');
  await env.DB.prepare('UPDATE drive_connections SET folder_id = ? WHERE account_id = ?').bind(created.body.id, accountId).run();
  return created.body.id;
}

// Returns a resumable session URL. It is scoped to this one upload, so the Mac
// never holds a Google token.
export async function startDriveUpload(env, accountId, { name, mimeType, size }, fetcher = fetch) {
  const { token, folderId } = await accessToken(env, accountId, fetcher);
  const parent = await folder(env, accountId, token, folderId, fetcher);
  const response = await fetcher('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,webViewLink,parents', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType, 'X-Upload-Content-Length': String(size) },
    body: JSON.stringify({ name, mimeType, parents: [parent] }),
  });
  const uploadUrl = response.headers.get('location');
  if (!response.ok || !uploadUrl?.startsWith('https://')) throw new Error('Google Drive did not open an upload');
  return uploadUrl;
}

// Records a finished upload after checking Google has it, in TagMails' folder, at the expected size.
export async function recordDriveFile(env, accountId, jobId, fileId, expectedSize, fetcher = fetch) {
  if (!DRIVE_FILE_ID.test(fileId ?? '')) throw new Error('Invalid Drive file');
  const { token, folderId } = await accessToken(env, accountId, fetcher);
  const found = await driveJson(fetcher, token, `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,size,webViewLink,parents,trashed`);
  const file = found.body;
  if (!found.ok || file.trashed || !file.parents?.includes(folderId) || Number(file.size) !== expectedSize ||
      !String(file.webViewLink ?? '').startsWith('https://')) throw new Error('Drive file did not match the upload');
  await env.DB.prepare(`INSERT OR IGNORE INTO drive_files (id, account_id, job_id, name, byte_size, web_link)
    VALUES (?, ?, ?, ?, ?, ?)`).bind(file.id, accountId, jobId, file.name, expectedSize, file.webViewLink).run();
  return { id: file.id, name: file.name, link: file.webViewLink };
}

export async function jobDriveFiles(env, accountId, jobId, ids) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const { results = [] } = await env.DB.prepare(`SELECT id, name, byte_size, web_link FROM drive_files
    WHERE account_id = ? AND job_id = ? AND id IN (${ids.map(() => '?').join(', ')}) ORDER BY created_at, id`)
    .bind(accountId, jobId, ...ids).all();
  return results;
}
