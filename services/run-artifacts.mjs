import { createHash, randomUUID } from 'node:crypto';

export const ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILE_BYTES = 24_000_000;
const MAX_RUN_BYTES = 25_000_000;
const MAX_FILES = 5;
const MIME_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

function json(value, status = 200) { return Response.json(value, { status }); }

async function fileBytes(request) {
  const length = request.headers.get('content-length');
  if (!length || !/^\d+$/.test(length)) throw new Error('File length required');
  if (Number(length) < 1 || Number(length) > MAX_FILE_BYTES) throw new Error('File too large');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing file');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FILE_BYTES) { await reader.cancel(); throw new Error('File too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (size !== Number(length)) throw new Error('File length changed');
  return Buffer.concat(chunks);
}

function metadata(request) {
  const url = new URL(request.url);
  const jobIds = url.searchParams.getAll('jobId');
  const leaseIds = url.searchParams.getAll('leaseId');
  let name;
  try { name = decodeURIComponent(request.headers.get('x-tagmails-filename') ?? ''); }
  catch { return null; }
  const mimeType = request.headers.get('content-type')?.toLowerCase() ?? '';
  const uploadId = request.headers.get('x-tagmails-upload-id');
  if (jobIds.length !== 1 || leaseIds.length !== 1 || !ARTIFACT_ID.test(jobIds[0]) ||
      !ARTIFACT_ID.test(leaseIds[0]) || !name || name.length > 120 || name === '.' || name === '..' ||
      /[\\/\x00-\x1f\x7f]/.test(name) || !MIME_TYPE.test(mimeType) ||
      (uploadId !== null && !ARTIFACT_ID.test(uploadId))) return null;
  return { jobId: jobIds[0], leaseId: leaseIds[0], name, mimeType, uploadId };
}

async function repeatedUpload(env, device, info, id, sha256, byteSize) {
  const existing = await env.DB.prepare(`SELECT account_id, job_id, lease_id, name, mime_type, byte_size, sha256
    FROM run_artifacts WHERE id = ? LIMIT 1`).bind(id).first();
  if (!existing) return null;
  if (existing.account_id !== device.account_id || existing.job_id !== info.jobId ||
      existing.lease_id !== info.leaseId || existing.name !== info.name ||
      existing.mime_type !== info.mimeType || existing.byte_size !== byteSize ||
      existing.sha256 !== sha256) return json({ error: 'Upload ID already used for a different file' }, 409);
  return json({ id, name: info.name, mimeType: info.mimeType, size: byteSize,
    expiresInDays: 7, duplicate: true }, 200);
}

async function activeLease(env, device, jobId, leaseId) {
  return env.DB.prepare(`SELECT j.id FROM jobs j JOIN threads t ON t.id = j.thread_id
    WHERE j.id = ? AND j.lease_id = ? AND j.device_id = ? AND t.account_id = ?
      AND j.state = 'running' AND j.lease_until > CURRENT_TIMESTAMP LIMIT 1`)
    .bind(jobId, leaseId, device.id, device.account_id).first();
}

export async function uploadRunArtifact(request, env, device) {
  const info = metadata(request);
  if (!info) return json({ error: 'Invalid file metadata' }, 400);
  if (!await activeLease(env, device, info.jobId, info.leaseId)) return json({ error: 'Lease expired or replaced' }, 409);
  let bytes;
  try { bytes = await fileBytes(request); }
  catch { return json({ error: 'Invalid or oversized file' }, 413); }
  if (!await activeLease(env, device, info.jobId, info.leaseId)) return json({ error: 'Lease expired or replaced' }, 409);
  const id = info.uploadId ?? randomUUID();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (info.uploadId) {
    const repeated = await repeatedUpload(env, device, info, id, sha256, bytes.length);
    if (repeated) return repeated;
  }
  // A distinct object key prevents two concurrent retries from overwriting
  // the winner's bytes before the database resolves the duplicate ID.
  const key = `artifacts/${device.account_id}/${info.jobId}/${info.leaseId}/${randomUUID()}`;
  await env.MAIL.put(key, bytes, { httpMetadata: { contentType: 'application/octet-stream' } });
  try {
    const inserted = await env.DB.prepare(`INSERT INTO run_artifacts
      (id, account_id, job_id, lease_id, object_key, name, mime_type, byte_size, sha256)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM jobs j JOIN threads t ON t.id = j.thread_id
        WHERE j.id = ? AND j.lease_id = ? AND j.device_id = ? AND t.account_id = ?
          AND j.state = 'running' AND j.lease_until > CURRENT_TIMESTAMP)
        AND (SELECT COUNT(*) FROM run_artifacts WHERE job_id = ?) < ?
        AND COALESCE((SELECT SUM(byte_size) FROM run_artifacts WHERE job_id = ?), 0) + ? <= ?
      RETURNING id`).bind(id, device.account_id, info.jobId, info.leaseId, key,
      info.name, info.mimeType, bytes.length, sha256, info.jobId, info.leaseId, device.id,
      device.account_id, info.jobId, MAX_FILES, info.jobId, bytes.length, MAX_RUN_BYTES).first();
    if (!inserted) {
      await env.MAIL.delete(key);
      return json({ error: 'Lease expired or file limit reached' }, 409);
    }
  } catch (error) {
    await env.MAIL.delete(key);
    if (info.uploadId) {
      const repeated = await repeatedUpload(env, device, info, id, sha256, bytes.length);
      if (repeated) return repeated;
    }
    throw error;
  }
  return json({ id, name: info.name, mimeType: info.mimeType, size: bytes.length,
    expiresInDays: 7 }, 201);
}

export async function selectedRunArtifacts(env, accountId, jobId, ids, leaseId = null) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const slots = ids.map(() => '?').join(', ');
  const rows = await env.DB.prepare(`SELECT id, name, mime_type, byte_size, expires_at
    FROM run_artifacts WHERE account_id = ? AND job_id = ?
      AND id IN (${slots}) AND (? IS NULL OR lease_id = ?)
      AND expires_at > CURRENT_TIMESTAMP`).bind(accountId, jobId, ...ids, leaseId, leaseId).all();
  return rows.results ?? rows;
}

export async function artifactForDownload(env, accountId, jobId, artifactId) {
  return env.DB.prepare(`SELECT id, name, mime_type, byte_size, object_key, expires_at, sha256
    FROM run_artifacts WHERE account_id = ? AND job_id = ? AND id = ?
      AND expires_at > CURRENT_TIMESTAMP LIMIT 1`).bind(accountId, jobId, artifactId).first();
}

export async function deleteExpiredRunArtifacts(env) {
  const found = await env.DB.prepare(`SELECT id, object_key FROM run_artifacts
    WHERE expires_at <= CURRENT_TIMESTAMP ORDER BY expires_at LIMIT 50`).bind().all();
  for (const row of found.results ?? found) {
    try {
      await env.MAIL.delete(row.object_key);
      await env.DB.prepare('DELETE FROM run_artifacts WHERE id = ? AND expires_at <= CURRENT_TIMESTAMP')
        .bind(row.id).run();
    } catch (error) { console.error('Run artifact deletion is delayed', error); }
  }
}
