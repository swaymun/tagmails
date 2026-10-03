import { createHash, createHmac, randomUUID } from 'node:crypto';
import { parseInbound, RELAY_INBOUND_LIMITS } from '../apps/mock-inbox/inbound.mjs';
import { chooseModel } from '../apps/mock-inbox/model.mjs';
import { testBillingEnabled } from './email-charges.mjs';
import { ARTIFACT_ID, selectedRunArtifacts, uploadRunArtifact } from './run-artifacts.mjs';

const TOKEN = /^tm_dev_[A-Za-z0-9_-]{43}$/;
const LEASE_SECONDS = 90;
const MAX_RESULT_BYTES = 64_000;

function json(value, status = 200) { return Response.json(value, { status }); }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }

async function deviceFor(request, env) {
  const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1];
  if (!TOKEN.test(token ?? '')) return null;
  const device = await env.DB.prepare(`SELECT d.id, d.account_id FROM devices d
    JOIN accounts a ON a.id = d.account_id
    WHERE d.token_hash = ? AND d.revoked_at IS NULL AND a.active = 1 LIMIT 1`)
    .bind(digest(token)).first();
  return device ? { ...device, token } : null;
}

async function boundedJson(request) {
  if (Number(request.headers.get('content-length') || 0) > MAX_RESULT_BYTES) throw new Error('Body too large');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing JSON body');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESULT_BYTES) { await reader.cancel(); throw new Error('Body too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); }
  catch { throw new Error('Invalid JSON body'); }
}

async function claim(env, device) {
  const leaseId = randomUUID();
  const funded = testBillingEnabled(env)
    ? `AND (json_extract(j.model_json, '$.error') IS NOT NULL OR EXISTS
        (SELECT 1 FROM test_email_charges c WHERE c.job_id = j.id AND c.state = 'reserved'))`
    : '';
  const row = await env.DB.prepare(`UPDATE jobs SET
    state = 'running', device_id = ?, lease_id = ?,
    lease_until = datetime('now', '+${LEASE_SECONDS} seconds'), attempts = attempts + 1
    WHERE id = (
      SELECT j.id FROM jobs j JOIN threads t ON t.id = j.thread_id
      JOIN messages m ON m.id = j.message_id JOIN accounts a ON a.id = t.account_id
      WHERE t.account_id = ? AND (j.state = 'queued' OR
        (j.state = 'running' AND (j.lease_until IS NULL OR j.lease_until <= CURRENT_TIMESTAMP)))
        ${funded}
        AND (m.sender_email = a.owner_email OR EXISTS (
          SELECT 1 FROM participants p WHERE p.thread_id = t.id AND p.email = m.sender_email AND p.revoked_at IS NULL))
      ORDER BY j.created_at, j.id LIMIT 1
    ) RETURNING id, thread_id, message_id, lease_until, model_json`)
    .bind(device.id, leaseId, device.account_id).first();
  if (!row) return json({ claimed: false });
  const message = await env.DB.prepare(`SELECT m.object_key, m.message_id, t.subject
    FROM messages m JOIN threads t ON t.id = m.thread_id
    WHERE m.id = ? AND m.account_id = ? LIMIT 1`).bind(row.message_id, device.account_id).first();
  if (!message) throw new Error('Claimed job has no inbound message');
  const object = await env.MAIL.get(message.object_key);
  if (!object) throw new Error('Claimed job has no stored MIME');
  const account = await env.DB.prepare('SELECT agent_email, owner_email, default_model FROM accounts WHERE id = ?').bind(device.account_id).first();
  const parsed = await parseInbound(await object.arrayBuffer(), account.agent_email, {
    verifiedDeliveryToAgent: true, ...RELAY_INBOUND_LIMITS, includeAttachmentData: false,
  });
  if (parsed.messageId !== message.message_id) throw new Error('Stored MIME no longer matches the claimed job');
  const envelope = {
    jobId: row.id, threadId: row.thread_id, leaseId, leaseUntil: row.lease_until,
    model: row.model_json ? JSON.parse(row.model_json) : chooseModel(parsed.body, account.default_model),
    request: { from: parsed.from, fromOwner: parsed.from === account.owner_email,
      subject: parsed.subject, body: parsed.body,
      attachments: parsed.attachments.map((attachment, index) => ({
        ...attachment, path: `/api/device/attachment?jobId=${row.id}&leaseId=${leaseId}&index=${index}`,
      })) },
  };
  const bytes = Buffer.from(JSON.stringify(envelope));
  const payload = bytes.toString('base64url');
  const signature = createHmac('sha256', device.token).update(bytes).digest('base64url');
  return json({ claimed: true, payload, signature });
}

async function attachment(request, env, device, url) {
  const jobId = url.searchParams.get('jobId');
  const leaseId = url.searchParams.get('leaseId');
  const index = url.searchParams.get('index');
  if (url.searchParams.size !== 3 || !/^[0-9a-f-]{36}$/i.test(jobId ?? '') ||
      !/^[0-9a-f-]{36}$/i.test(leaseId ?? '') || !/^[0-4]$/.test(index ?? '')) {
    return json({ error: 'Invalid attachment request' }, 400);
  }
  const message = await env.DB.prepare(`SELECT m.object_key, m.message_id, a.agent_email
    FROM jobs j JOIN threads t ON t.id = j.thread_id
    JOIN messages m ON m.id = j.message_id
    JOIN accounts a ON a.id = t.account_id
    WHERE j.id = ? AND j.device_id = ? AND j.lease_id = ?
      AND j.state = 'running' AND j.lease_until > CURRENT_TIMESTAMP
      AND t.account_id = ? LIMIT 1`)
    .bind(jobId, device.id, leaseId, device.account_id).first();
  if (!message) return json({ error: 'Lease expired or replaced' }, 409);
  const object = await env.MAIL.get(message.object_key);
  if (!object) throw new Error('Claimed job has no stored MIME');
  const parsed = await parseInbound(await object.arrayBuffer(), message.agent_email, {
    verifiedDeliveryToAgent: true, ...RELAY_INBOUND_LIMITS,
    includeAttachmentData: false, attachmentBytesAt: Number(index),
  });
  if (parsed.messageId !== message.message_id) throw new Error('Stored MIME no longer matches the claimed job');
  const file = parsed.attachments[Number(index)];
  if (!file) return json({ error: 'Attachment not found' }, 404);
  return new Response(file.bytes, { headers: {
    'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
  } });
}

async function renew(env, device, body) {
  if (typeof body.jobId !== 'string' || typeof body.leaseId !== 'string') return json({ error: 'Invalid lease' }, 400);
  const row = await env.DB.prepare(`UPDATE jobs SET lease_until = datetime('now', '+${LEASE_SECONDS} seconds')
    WHERE id = ? AND device_id = ? AND lease_id = ? AND state = 'running'
      AND lease_until > CURRENT_TIMESTAMP RETURNING lease_until`)
    .bind(body.jobId, device.id, body.leaseId).first();
  return row ? json({ renewed: true, leaseUntil: row.lease_until }) : json({ error: 'Lease expired or replaced' }, 409);
}

function validResult(value) {
  if (!value || !['completed', 'failed', 'needs_approval', 'needs_clarification'].includes(value.state) ||
      typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 500) return false;
  const tokens = ['inputTokens', 'cachedInputTokens', 'cacheCreationInputTokens', 'outputTokens', 'reasoningOutputTokens'];
  const transcript = value.transcript;
  const artifactIds = value.artifactIds;
  return ['details', 'checks'].every((key) => value[key] === undefined ||
    (Array.isArray(value[key]) && value[key].length <= 12 && value[key].every((item) => typeof item === 'string' && item.length <= 300))) &&
    (transcript === undefined || (transcript?.version === 1 && typeof transcript.truncated === 'boolean' &&
      Array.isArray(transcript.events) && transcript.events.length <= 48 &&
      transcript.events.every((event) => event && ['request', 'assistant', 'tool'].includes(event.kind) &&
        typeof event.text === 'string' && event.text.length > 0 && event.text.length <= 800))) &&
    (artifactIds === undefined || (Array.isArray(artifactIds) && artifactIds.length <= 5 &&
      artifactIds.every((id) => typeof id === 'string' && ARTIFACT_ID.test(id)) &&
      new Set(artifactIds).size === artifactIds.length)) &&
    (value.usage === undefined || (value.usage && typeof value.usage === 'object' &&
      tokens.every((key) => Number.isSafeInteger(value.usage[key]) && value.usage[key] >= 0 && value.usage[key] <= 1_000_000_000))) &&
    (value.reportedListCostUsd === undefined || (typeof value.reportedListCostUsd === 'number' &&
      Number.isFinite(value.reportedListCostUsd) && value.reportedListCostUsd >= 0 && value.reportedListCostUsd <= 1000));
}

async function complete(env, device, body) {
  if (typeof body.jobId !== 'string' || typeof body.leaseId !== 'string' || !validResult(body.result)) {
    return json({ error: 'Invalid completion' }, 400);
  }
  const serialized = JSON.stringify(body.result);
  const resultHash = digest(serialized);
  const current = await env.DB.prepare(`SELECT j.state, j.lease_id, j.result_hash,
    (j.lease_until > CURRENT_TIMESTAMP) AS lease_valid
    FROM jobs j JOIN threads t ON t.id = j.thread_id
    WHERE j.id = ? AND j.device_id = ? AND t.account_id = ? LIMIT 1`)
    .bind(body.jobId, device.id, device.account_id).first();
  if (!current) return json({ error: 'Job not found' }, 404);
  if (['completed', 'failed'].includes(current.state)) {
    return current.lease_id === body.leaseId && current.result_hash === resultHash
      ? json({ completed: true, duplicate: true }) : json({ error: 'Job already finished' }, 409);
  }
  if (current.state !== 'running' || current.lease_id !== body.leaseId || !current.lease_valid) {
    return json({ error: 'Lease expired or replaced' }, 409);
  }
  if (body.result.artifactIds?.length) {
    const files = await selectedRunArtifacts(env, device.account_id, body.jobId,
      body.result.artifactIds, body.leaseId);
    if (files.length !== body.result.artifactIds.length) return json({ error: 'Unknown or expired artifact' }, 400);
  }
  const key = `results/${device.account_id}/${body.jobId}/${body.leaseId}.json`;
  await env.MAIL.put(key, serialized, { httpMetadata: { contentType: 'application/json' } });
  const state = body.result.state === 'failed' ? 'failed' : 'completed';
  // Completion and its one outbound reply commit together. A replaced lease
  // cannot enqueue mail even if it uploaded a result object first.
  const updated = await env.DB.batch([
    env.DB.prepare(`UPDATE jobs SET state = ?, result_key = ?, result_hash = ?, lease_until = NULL
      WHERE id = ? AND device_id = ? AND lease_id = ? AND state = 'running'
        AND lease_until > CURRENT_TIMESTAMP`).bind(state, key, resultHash, body.jobId, device.id, body.leaseId),
    env.DB.prepare(`INSERT INTO outbox (job_id) SELECT id FROM jobs
      WHERE id = ? AND device_id = ? AND lease_id = ? AND result_hash = ? AND state = ?`)
      .bind(body.jobId, device.id, body.leaseId, resultHash, state),
  ]);
  return (updated[1].meta?.changes ?? updated[1].changes) === 1
    ? json({ completed: true, duplicate: false }) : json({ error: 'Lease expired or replaced' }, 409);
}

export async function handleDeviceRequest(request, env) {
  const url = new URL(request.url);
  if (!((request.method === 'GET' && url.pathname === '/api/device/attachment') ||
    (request.method === 'POST' && ['/api/device/claim', '/api/device/renew', '/api/device/complete', '/api/device/artifacts'].includes(url.pathname)))) {
    return new Response('Not found', { status: 404 });
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) return json({ error: 'HTTPS required' }, 403);
  if (!env.DB || !env.MAIL) throw new Error('Device job bindings are incomplete');
  const device = await deviceFor(request, env);
  if (!device) return json({ error: 'Unauthorized device' }, 401);
  if (url.pathname === '/api/device/attachment') return attachment(request, env, device, url);
  if (url.pathname === '/api/device/claim') return claim(env, device);
  if (url.pathname === '/api/device/artifacts') return uploadRunArtifact(request, env, device);
  let body;
  try { body = await boundedJson(request); }
  catch { return json({ error: 'Invalid or oversized JSON body' }, 400); }
  return url.pathname === '/api/device/renew' ? renew(env, device, body) : complete(env, device, body);
}
