import { createHash, createHmac, randomUUID } from 'node:crypto';
import { parseInbound, RELAY_INBOUND_LIMITS } from '../apps/mock-inbox/inbound.mjs';
import { chooseModel } from '../apps/mock-inbox/model.mjs';
import { ATTACHABLE_BYTES, testBillingEnabled } from './email-charges.mjs';
import { ARTIFACT_ID, EMAIL_SAFE_FILE, selectedRunArtifacts, uploadRunArtifact } from './run-artifacts.mjs';
import { catalogFromDevice, deviceDefaults, deviceLimits } from './model-catalog.mjs';
import { cleanProjectCatalog } from './project-route.mjs';
import { sealText } from './storage-crypto.mjs';
import { attachmentKey, registerDeviceKey, resultMeta, sealedObject, sealedObjectText, storeSealedResult } from './device-sealing.mjs';
import { deliverReply, heldReplies, sendHeldReply } from './outbox.mjs';
import { currentText } from './jev-route.mjs';
import { openDevicePush } from './device-push.mjs';
import { rateLimited, tooManyRequests } from './rate-limit.mjs';

const TOKEN = /^tm_dev_[A-Za-z0-9_-]{43}$/;
const LEASE_SECONDS = 90;
// A run whose lease lapsed this many times (the Mac slept, restarted or the
// adapter crashed) is not handed out again: each retry costs the owner a full
// agent turn, and the job blocks every later turn in its thread.
export const MAX_ATTEMPTS = 3;
// A full answer (32k characters) plus its transcript (48 events) is up to
// ~170 KB of UTF-8 when the text is CJK or emoji; 64 KB refused real replies.
const MAX_RESULT_BYTES = 256_000;
// A computer with a sealing key sends its reply's files with the completion
// (base64), and posts held replies back whole, so the relay stores neither.
const MAX_SEALED_BODY_BYTES = 6_000_000;
const MIME_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
// The full answer for the reply email; summary/details stay as a short preview.
const MAX_ANSWER_CHARS = 32_000;

function json(value, status = 200) { return Response.json(value, { status }); }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }

async function deviceFor(request, env) {
  const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1];
  if (!TOKEN.test(token ?? '')) return null;
  const device = await env.DB.prepare(`SELECT d.id, d.account_id, d.key_id, d.public_key FROM devices d
    JOIN accounts a ON a.id = d.account_id
    WHERE d.token_hash = ? AND d.revoked_at IS NULL AND a.active = 1 LIMIT 1`)
    .bind(digest(token)).first();
  return device ? { ...device, token } : null;
}

async function boundedJson(request, limit = MAX_RESULT_BYTES) {
  if (Number(request.headers.get('content-length') || 0) > limit) throw new Error('Body too large');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing JSON body');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('Body too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); }
  catch { throw new Error('Invalid JSON body'); }
}

// A daemon running several jobs names the project folders it is busy in, so a
// second thread never lands in a checkout another job is using. Older daemons
// send {} and keep one job at a time.
async function busyFolders(request) {
  try {
    const folders = (await boundedJson(request))?.busyFolders;
    return Array.isArray(folders) ? folders.filter((folder) => typeof folder === 'string' && folder.length <= 1024).slice(0, 16) : [];
  } catch { return []; }
}

async function claim(env, device, busy = []) {
  // Claims also come from idle polls (every 15s without push, every 10 minutes
  // with it), so most find the queue empty. Throttle the last-seen write.
  await env.DB.prepare(`UPDATE devices SET last_seen_at = CURRENT_TIMESTAMP
    WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-2 minutes'))`)
    .bind(device.id).run();
  const leaseId = randomUUID();
  const funded = testBillingEnabled(env)
    ? `AND EXISTS
        (SELECT 1 FROM test_email_charges c WHERE c.job_id = j.id AND c.state = 'reserved')`
    : '';
  const eligible = `(j.state = 'queued' OR
      (j.state = 'running' AND (j.lease_until IS NULL OR j.lease_until <= CURRENT_TIMESTAMP)
        AND j.attempts < ${MAX_ATTEMPTS}))
    ${funded}
    AND json_extract(j.model_json, '$.error') IS NULL
    AND (m.sender_email = a.owner_email OR EXISTS (
      SELECT 1 FROM participants p WHERE p.thread_id = t.id AND p.email = m.sender_email AND p.revoked_at IS NULL))
    AND NOT EXISTS (SELECT 1 FROM jobs earlier WHERE earlier.thread_id = j.thread_id
      AND earlier.state IN ('queued', 'running') AND earlier.rowid < j.rowid)
    AND (m.seal_key_id IS NULL OR m.seal_key_id = ?)
    AND (json_extract(j.workspace_json, '$.kind') IS NOT 'project'
      OR json_extract(j.workspace_json, '$.path') NOT IN (SELECT value FROM json_each(?)))`;
  // Pin the thread before claiming its first job. A second Mac cannot claim a
  // later turn, and a lease retry stays on the Mac with the local session.
  await env.DB.prepare(`UPDATE threads SET device_id = ? WHERE id = (
    SELECT t.id FROM jobs j JOIN threads t ON t.id = j.thread_id
    JOIN messages m ON m.id = j.message_id JOIN accounts a ON a.id = t.account_id
    WHERE t.account_id = ? AND t.device_id IS NULL AND ${eligible}
    ORDER BY j.created_at, j.rowid LIMIT 1
  ) AND device_id IS NULL`).bind(device.id, device.account_id, device.key_id ?? '', JSON.stringify(busy)).run();
  const row = await env.DB.prepare(`UPDATE jobs SET
    state = 'running', device_id = ?, lease_id = ?,
    lease_until = datetime('now', '+${LEASE_SECONDS} seconds'), attempts = attempts + 1
    WHERE id = (
      SELECT j.id FROM jobs j JOIN threads t ON t.id = j.thread_id
      JOIN messages m ON m.id = j.message_id JOIN accounts a ON a.id = t.account_id
      WHERE t.account_id = ? AND t.device_id = ? AND ${eligible}
      ORDER BY j.created_at, j.rowid LIMIT 1
    ) RETURNING id, thread_id, message_id, lease_until, model_json, workspace_json`)
    .bind(device.id, leaseId, device.account_id, device.id, device.key_id ?? '', JSON.stringify(busy)).first();
  if (!row) return json({ claimed: false, ...await heldNotice(env, device) });
  // Files an expired lease uploaded can never be sent; let the cleanup delete them
  // so retries don't pile up storage.
  await env.DB.prepare(`UPDATE run_artifacts SET expires_at = CURRENT_TIMESTAMP
    WHERE job_id = ? AND lease_id != ?`).bind(row.id, leaseId).run();
  const message = await env.DB.prepare(`SELECT m.object_key, m.message_id, m.agent_email, m.sender_email, m.seal_key_id, t.subject
    FROM messages m JOIN threads t ON t.id = m.thread_id
    WHERE m.id = ? AND m.account_id = ? LIMIT 1`).bind(row.message_id, device.account_id).first();
  if (!message) throw new Error('Claimed job has no inbound message');
  const account = await env.DB.prepare('SELECT agent_email, owner_email, default_model FROM accounts WHERE id = ?').bind(device.account_id).first();
  const workspace = row.workspace_json ? JSON.parse(row.workspace_json) : null;
  const common = {
    jobId: row.id, threadId: row.thread_id, leaseId, leaseUntil: row.lease_until,
    ...(workspace?.kind === 'project' ? { workspace: { kind: 'project', path: workspace.path } }
      : workspace?.kind === 'scratch' ? { workspace: { kind: 'scratch' } } : {}),
  };
  let envelope;
  if (message.seal_key_id) {
    // Sealed to this computer: it opens the request (agent/device-key.mjs
    // openClaim) and builds the prompt itself. The relay can't read it.
    const sealed = await sealedObjectText(env, message.object_key);
    if (!sealed) throw new Error('Claimed job has no sealed request');
    const model = row.model_json ? JSON.parse(row.model_json) : chooseModel('', account.default_model);
    envelope = { ...common, sealed: true, model,
      request: { from: message.sender_email, fromOwner: message.sender_email === account.owner_email, sealed,
        earlier: await unrunEarlierRequests(env, device, row, message.agent_email ?? account.agent_email, true) } };
  } else {
    const object = await env.MAIL.get(message.object_key);
    if (!object) throw new Error('Claimed job has no stored MIME');
    const parsed = await parseInbound(await object.arrayBuffer(), message.agent_email ?? account.agent_email, {
      verifiedDeliveryToAgent: true, ...RELAY_INBOUND_LIMITS, includeAttachmentData: false,
    });
    if (parsed.messageId !== message.message_id) throw new Error('Stored MIME no longer matches the claimed job');
    const earlier = await unrunEarlierRequests(env, device, row, message.agent_email ?? account.agent_email, false);
    const body = earlier.length ? `${earlier.map((item) =>
      `Earlier in this thread, ${item.from} wrote (the relay replied without running an agent):\n${item.text}`).join('\n\n')}\n\nThe current message:\n${parsed.body}` : parsed.body;
    envelope = { ...common,
      model: row.model_json ? JSON.parse(row.model_json) : chooseModel(parsed.body, account.default_model),
      request: { from: parsed.from, fromOwner: parsed.from === account.owner_email,
        subject: parsed.subject, body,
        attachments: parsed.attachments.map((attachment, index) => ({
          ...attachment, path: `/api/device/attachment?jobId=${row.id}&leaseId=${leaseId}&index=${index}`,
        })) } };
  }
  const bytes = Buffer.from(JSON.stringify(envelope));
  const payload = bytes.toString('base64url');
  const signature = createHmac('sha256', device.token).update(bytes).digest('base64url');
  return json({ claimed: true, payload, signature, ...await heldNotice(env, device) });
}

// Tells a computer it holds replies waiting to be sent (agent/device-key.mjs send-pending).
async function heldNotice(env, device) {
  return device.key_id && (await heldReplies(env, device, 1, false)).length ? { pendingSends: true } : {};
}

// A turn the relay answered itself ("which project?", an unavailable model)
// never reached an agent, and the sender's reply usually quotes only that
// answer. Hand the agent those earlier requests, newest last.
// Only the claiming sender's own earlier requests: a participant's text must
// never ride into the owner's turn (owner access and tools), nor the reverse.
// The earlier relay-answered jobs a claim of job ?1 carries (newest three).
// Completion marks exactly these as handed over, so an older one the claim
// left out is still offered to the next turn.
const EARLIER_REQUESTS = `SELECT j.id FROM jobs j JOIN messages m ON m.id = j.message_id
  WHERE j.thread_id = (SELECT thread_id FROM jobs WHERE id = ?1) AND j.id != ?1
    AND json_type(j.model_json, '$.error') = 'text'
    AND (j.created_at, j.rowid) < (SELECT created_at, rowid FROM jobs WHERE id = ?1)
    AND j.handed_to_agent_at IS NULL
    AND m.sender_email = (SELECT cm.sender_email FROM jobs cj JOIN messages cm ON cm.id = cj.message_id WHERE cj.id = ?1)
  ORDER BY j.created_at DESC, j.rowid DESC LIMIT 3`;

// For a sealed claim, earlier sealed requests go to the computer as they are
// ({ from, sealed }); relay-key ones are read here ({ from, text }).
async function unrunEarlierRequests(env, device, row, agentEmail, sealedClaim) {
  const { results = [] } = await env.DB.prepare(`SELECT m.object_key, m.message_id, m.sender_email, m.seal_key_id FROM jobs j
    JOIN messages m ON m.id = j.message_id JOIN threads t ON t.id = j.thread_id
    WHERE j.id IN (${EARLIER_REQUESTS}) AND t.account_id = ?2
    ORDER BY j.created_at DESC, j.rowid DESC`)
    .bind(row.id, device.account_id).all();
  const earlier = [];
  for (const item of results.reverse()) {
    if (item.seal_key_id) {
      const sealed = sealedClaim && item.seal_key_id === device.key_id ? await sealedObjectText(env, item.object_key) : null;
      if (sealed) earlier.push({ from: item.sender_email, sealed });
      continue;
    }
    const object = await env.MAIL.get(item.object_key);
    if (!object) continue;
    try {
      const parsed = await parseInbound(await object.arrayBuffer(), agentEmail, {
        verifiedDeliveryToAgent: true, ...RELAY_INBOUND_LIMITS, includeAttachmentData: false,
      });
      const text = currentText(parsed.body).trim();
      if (parsed.messageId === item.message_id && parsed.from === item.sender_email && text) earlier.push({ from: parsed.from, text });
    } catch { /* Skip a message that no longer parses. */ }
  }
  return earlier;
}

async function attachment(request, env, device, url) {
  const jobId = url.searchParams.get('jobId');
  const leaseId = url.searchParams.get('leaseId');
  const index = url.searchParams.get('index');
  if (url.searchParams.size !== 3 || !/^[0-9a-f-]{36}$/i.test(jobId ?? '') ||
      !/^[0-9a-f-]{36}$/i.test(leaseId ?? '') || !/^[0-4]$/.test(index ?? '')) {
    return json({ error: 'Invalid attachment request' }, 400);
  }
  const message = await env.DB.prepare(`SELECT m.object_key, m.message_id, m.seal_key_id, COALESCE(m.agent_email, a.agent_email) AS agent_email
    FROM jobs j JOIN threads t ON t.id = j.thread_id
    JOIN messages m ON m.id = j.message_id
    JOIN accounts a ON a.id = t.account_id
    WHERE j.id = ? AND j.device_id = ? AND j.lease_id = ?
      AND j.state = 'running' AND j.lease_until > CURRENT_TIMESTAMP
      AND t.account_id = ? LIMIT 1`)
    .bind(jobId, device.id, leaseId, device.account_id).first();
  if (!message) return json({ error: 'Lease expired or replaced' }, 409);
  if (message.seal_key_id) {
    // Sealed to the claiming computer, which opens it.
    const sealed = await sealedObject(env, attachmentKey(message.object_key, Number(index)));
    if (!sealed) return json({ error: 'Attachment not found' }, 404);
    return new Response(sealed, { headers: {
      'Content-Type': 'application/octet-stream', 'Content-Length': String(sealed.length),
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-TagMails-Sealed': 'device',
      'Content-Security-Policy': "default-src 'none'",
    } });
  }
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
  if (!row) return json({ error: 'Lease expired or replaced' }, 409);
  return json({ renewed: true, leaseUntil: row.lease_until, steers: await pendingSteers(env, device, body.jobId) });
}

// Follow-up emails waiting to steer this run. The computer confirms each one
// with /api/device/steered; until then it stays pending and is re-offered.
// Only the run's own sender may steer it (see steerTarget in relay-worker.mjs).
async function pendingSteers(env, device, jobId) {
  const { results = [] } = await env.DB.prepare(`SELECT s.id, m.object_key, m.message_id, m.agent_email, m.sender_email, m.seal_key_id FROM jobs s
    JOIN messages m ON m.id = s.message_id
    JOIN jobs r ON r.id = s.steer_of JOIN messages rm ON rm.id = r.message_id
    WHERE s.steer_of = ? AND s.steer_state = 'pending' AND m.sender_email = rm.sender_email
    ORDER BY s.rowid LIMIT 3`).bind(jobId).all();
  const steers = [];
  for (const item of results) {
    try {
      if (item.seal_key_id) {
        // The computer opens it (agent/claim-renew.mjs); another key's follow-up waits and queues.
        const sealed = item.seal_key_id === device.key_id ? await sealedObjectText(env, item.object_key) : null;
        if (sealed) steers.push({ id: item.id, from: item.sender_email, sealed });
        continue;
      }
      const object = await env.MAIL.get(item.object_key);
      if (!object) continue;
      const parsed = await parseInbound(await object.arrayBuffer(), item.agent_email, {
        verifiedDeliveryToAgent: true, ...RELAY_INBOUND_LIMITS, includeAttachmentData: false });
      if (parsed.messageId !== item.message_id) continue;
      const text = currentText(parsed.body).trim();
      if (text) steers.push({ id: item.id, from: parsed.from, text });
    } catch { /* Left pending; it queues when the run ends. */ }
  }
  return steers;
}

async function steered(env, device, body) {
  if (typeof body.jobId !== 'string' || typeof body.leaseId !== 'string' || typeof body.steerId !== 'string') {
    return json({ error: 'Invalid steer' }, 400);
  }
  const run = await env.DB.prepare(`SELECT id FROM jobs WHERE id = ? AND device_id = ? AND lease_id = ? AND state = 'running'`)
    .bind(body.jobId, device.id, body.leaseId).first();
  if (!run) return json({ error: 'Lease expired or replaced' }, 409);
  // Delivered stays completed with no reply. Undelivered becomes an ordinary queued job.
  await env.DB.prepare(body.delivered === true
    ? `UPDATE jobs SET steer_state = 'delivered' WHERE id = ? AND steer_of = ? AND steer_state = 'pending'`
    : `UPDATE jobs SET state = 'queued', steer_state = NULL WHERE id = ? AND steer_of = ? AND steer_state = 'pending'`)
    .bind(body.steerId, body.jobId).run();
  return json({ ok: true });
}

async function started(env, device, body) {
  if (typeof body.jobId !== 'string' || typeof body.leaseId !== 'string') return json({ error: 'Invalid lease' }, 400);
  const row = await env.DB.prepare(`SELECT m.sender_email FROM jobs j
    JOIN threads t ON t.id = j.thread_id JOIN messages m ON m.id = j.message_id
    WHERE j.id = ? AND j.device_id = ? AND j.lease_id = ? AND j.state = 'running'
      AND j.lease_until > CURRENT_TIMESTAMP AND t.account_id = ? LIMIT 1`)
    .bind(body.jobId, device.id, body.leaseId, device.account_id).first();
  if (!row) return json({ error: 'Lease expired or replaced' }, 409);
  // No 📝 reaction: Gmail can't remove a reaction, so the email keeps only
  // 👀 (received) and the final ✅ or ⚠️.
  return json({ started: true });
}

// The Rust daemon cuts the text it adds (checks, the instructions notice) by
// characters, so limits count code points: 300 emoji are 600 UTF-16 units.
function characters(text) { return [...text].length; }

function validResult(value) {
  if (!value || !['completed', 'failed', 'needs_approval', 'needs_clarification'].includes(value.state) ||
      typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 500 ||
      (value.answer !== undefined && (typeof value.answer !== 'string' || value.answer.length > MAX_ANSWER_CHARS))) return false;
  const tokens = ['inputTokens', 'cachedInputTokens', 'cacheCreationInputTokens', 'outputTokens', 'reasoningOutputTokens'];
  const transcript = value.transcript;
  const artifactIds = value.artifactIds;
  return ['details', 'checks'].every((key) => value[key] === undefined ||
    (Array.isArray(value[key]) && value[key].length <= 12 && value[key].every((item) => typeof item === 'string' && characters(item) <= 300))) &&
    (transcript === undefined || (transcript?.version === 1 && typeof transcript.truncated === 'boolean' &&
      Array.isArray(transcript.events) && transcript.events.length <= 48 &&
      transcript.events.every((event, index) => event && ['request', 'assistant', 'tool', 'reasoning'].includes(event.kind) &&
        (event.phase === undefined || (event.kind === 'assistant' &&
          ['commentary', 'final_answer'].includes(event.phase))) &&
        typeof event.text === 'string' && event.text.length > 0 &&
        event.text.length <= (index === transcript.events.length - 1 && event.kind === 'assistant' &&
          event.phase !== 'commentary' ? 8000 : 800)))) &&
    (value.instructionsNotice === undefined || (typeof value.instructionsNotice === 'string' &&
      value.instructionsNotice.length > 0 && characters(value.instructionsNotice) <= 300)) &&
    // Daemon 0.2.19 may still report Drive files; they're ignored.
    (value.driveFileIds === undefined || (Array.isArray(value.driveFileIds) && value.driveFileIds.length <= 5)) &&
    (value.unsentFiles === undefined || (Array.isArray(value.unsentFiles) && value.unsentFiles.length <= 5 &&
      value.unsentFiles.every((file) => typeof file?.name === 'string' && file.name.length <= 120 &&
        ['drive-not-connected', 'drive-unavailable', 'too-large', 'failed'].includes(file.reason)))) &&
    (artifactIds === undefined || (Array.isArray(artifactIds) && artifactIds.length <= 5 &&
      artifactIds.every((id) => typeof id === 'string' && ARTIFACT_ID.test(id)) &&
      new Set(artifactIds).size === artifactIds.length)) &&
    (value.usage === undefined || (value.usage && typeof value.usage === 'object' &&
      tokens.every((key) => Number.isSafeInteger(value.usage[key]) && value.usage[key] >= 0 && value.usage[key] <= 1_000_000_000))) &&
    (value.codexAllowance === undefined || (value.codexAllowance &&
      Number.isSafeInteger(value.codexAllowance.observedAt) &&
      value.codexAllowance.observedAt > 0 && Array.isArray(value.codexAllowance.windows) &&
      value.codexAllowance.windows.length >= 1 && value.codexAllowance.windows.length <= 2 &&
      value.codexAllowance.windows.every((window) => Number.isSafeInteger(window.durationMins) &&
        window.durationMins > 0 && window.durationMins <= 10_080 &&
        Number.isInteger(window.remainingPercent) && window.remainingPercent >= 0 && window.remainingPercent <= 100 &&
        Number.isSafeInteger(window.resetsAt) && window.resetsAt > 0))) &&
    (value.session === undefined || (['codex', 'claude'].includes(value.session?.harness) &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.session?.id ?? ''))) &&
    (value.reportedListCostUsd === undefined || (typeof value.reportedListCostUsd === 'number' &&
      Number.isFinite(value.reportedListCostUsd) && value.reportedListCostUsd >= 0 && value.reportedListCostUsd <= 1000));
}

// Fails one run that used up its attempts, with a relay reply in the thread.
// Returns false when there is none. Called from the scheduled handler.
export async function failOneAbandonedJob(env) {
  const row = await env.DB.prepare(`SELECT j.id, t.account_id FROM jobs j JOIN threads t ON t.id = j.thread_id
    WHERE j.state = 'running' AND j.attempts >= ${MAX_ATTEMPTS}
      AND (j.lease_until IS NULL OR j.lease_until <= CURRENT_TIMESTAMP)
    ORDER BY j.created_at, j.rowid LIMIT 1`).bind().first();
  if (!row) return false;
  const key = `results/${row.account_id}/${row.id}/abandoned.json`;
  await env.MAIL.put(key, JSON.stringify({ runtime: 'relay', state: 'failed',
    summary: `Your computer started this task ${MAX_ATTEMPTS} times and stopped responding each time (it may have slept, restarted or crashed), so TagMails stopped retrying. Reply to try again.`,
    checks: ['The agent may have made partial changes before it stopped.'] }),
  { httpMetadata: { contentType: 'application/json' } });
  const [updated] = await env.DB.batch([
    env.DB.prepare(`UPDATE jobs SET state = 'failed', result_key = ?, lease_until = NULL
      WHERE id = ? AND state = 'running' AND attempts >= ${MAX_ATTEMPTS}
        AND (lease_until IS NULL OR lease_until <= CURRENT_TIMESTAMP)`).bind(key, row.id),
    env.DB.prepare(`INSERT OR IGNORE INTO outbox (job_id)
      SELECT id FROM jobs WHERE id = ? AND state = 'failed' AND result_key = ?`).bind(row.id, key),
    // Follow-ups that were waiting to steer it run as their own turns.
    env.DB.prepare(`UPDATE jobs SET state = 'queued', steer_state = NULL
      WHERE steer_of = ? AND steer_state = 'pending'
        AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND state = 'failed' AND result_key = ?)`).bind(row.id, row.id, key),
  ]);
  return (updated.meta?.changes ?? updated.changes) === 1;
}

async function leasedJob(env, device, body) {
  if (!ARTIFACT_ID.test(body?.jobId ?? '') || !ARTIFACT_ID.test(body?.leaseId ?? '')) return null;
  return env.DB.prepare(`SELECT j.id,
      (SELECT COALESCE(SUM(byte_size), 0) FROM run_artifacts r WHERE r.job_id = j.id AND r.lease_id = j.lease_id) AS stored_bytes
    FROM jobs j JOIN threads t ON t.id = j.thread_id JOIN messages m ON m.id = j.message_id
    JOIN accounts a ON a.id = t.account_id
    WHERE j.id = ? AND j.lease_id = ? AND j.device_id = ? AND t.account_id = ?
      AND j.state = 'running' AND j.lease_until > CURRENT_TIMESTAMP LIMIT 1`)
    .bind(body.jobId, body.leaseId, device.id, device.account_id).first();
}

// Where a file the agent attached should go. TagMails doesn't host files:
// one a mail client can open that still fits in the email goes through relay
// storage into it; anything else is named in the reply as not sent.
async function fileRoute(env, device, body) {
  const job = await leasedJob(env, device, body);
  if (!job) return json({ error: 'Lease expired or replaced' }, 409);
  const name = typeof body.name === 'string' ? body.name : '';
  const size = body.size;
  if (!name || name.length > 120 || /[\\/\x00-\x1f\x7f]/.test(name) || !Number.isSafeInteger(size) || size < 1) {
    return json({ error: 'Invalid file' }, 400);
  }
  if (EMAIL_SAFE_FILE.test(name) && job.stored_bytes + size <= ATTACHABLE_BYTES) return json({ route: 'relay' });
  return json({ route: 'none', reason: 'too-large' });
}

// Files a sealed completion carries for the reply: [{ name, mimeType, content (base64) }].
function inlineFiles(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 5) return null;
  const files = [];
  for (const file of value) {
    if (typeof file?.name !== 'string' || !file.name || file.name.length > 120 || /[\\/\x00-\x1f\x7f]/.test(file.name) ||
        !EMAIL_SAFE_FILE.test(file.name) || typeof file.mimeType !== 'string' || !MIME_TYPE.test(file.mimeType) ||
        typeof file.content !== 'string' || !file.content || Buffer.from(file.content, 'base64').toString('base64') !== file.content) return null;
    files.push({ name: file.name, mimeType: file.mimeType.toLowerCase(), content: file.content });
  }
  return files;
}

// Sends the reply for a sealed job from what the computer just posted; the
// relay keeps only the sealed result. A failure here leaves the reply queued
// for the computer's retry of this completion.
async function sendSealedReply(env, jobId, body, files) {
  try {
    return (await deliverReply(env, jobId, { result: body.result, subject: body.subject, files })).state;
  } catch (error) {
    console.error('Sealed reply send is delayed', jobId, error instanceof Error ? error.message : 'Unknown error');
    return 'delayed';
  }
}

async function complete(env, device, body) {
  if (typeof body.jobId !== 'string' || typeof body.leaseId !== 'string' || !validResult(body.result)) {
    return json({ error: 'Invalid completion' }, 400);
  }
  const serialized = JSON.stringify(body.result);
  const resultHash = digest(serialized);
  const current = await env.DB.prepare(`SELECT j.state, j.lease_id, j.result_hash, m.seal_key_id,
    (j.lease_until > CURRENT_TIMESTAMP) AS lease_valid
    FROM jobs j JOIN threads t ON t.id = j.thread_id JOIN messages m ON m.id = j.message_id
    WHERE j.id = ? AND j.device_id = ? AND t.account_id = ? LIMIT 1`)
    .bind(body.jobId, device.id, device.account_id).first();
  if (!current) return json({ error: 'Job not found' }, 404);
  // Mail sealed to this computer: the reply's subject and files come with the
  // completion, since the relay can't read the stored mail.
  const sealed = Boolean(current.seal_key_id) && current.seal_key_id === device.key_id;
  if (current.seal_key_id && !sealed) return json({ error: 'This job is sealed to another key' }, 409);
  const files = sealed ? inlineFiles(body.files) : [];
  if (sealed && (files === null || typeof body.subject !== 'string' || body.subject.length > 998 || /[\r\n]/.test(body.subject) ||
      body.result.artifactIds?.length)) {
    return json({ error: 'Invalid sealed completion' }, 400);
  }
  if (['completed', 'failed'].includes(current.state)) {
    if (current.lease_id !== body.leaseId || current.result_hash !== resultHash) return json({ error: 'Job already finished' }, 409);
    // A retried completion whose reply never went out (the Worker stopped
    // after storing it) sends it now.
    return json({ completed: true, duplicate: true, ...(sealed ? { reply: await sendSealedReply(env, body.jobId, body, files) } : {}) });
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
  if (sealed) await storeSealedResult(env, device.public_key, key, body.result);
  else await env.MAIL.put(key, serialized, { httpMetadata: { contentType: 'application/json' } });
  const state = body.result.state === 'failed' ? 'failed' : 'completed';
  const reactionStatus = body.result.state === 'completed' ? 'completed'
    : body.result.state === 'failed' ? 'failed' : null;
  // Completion and its one outbound reply commit together. A replaced lease
  // cannot enqueue mail even if it uploaded a result object first.
  const statements = [
    env.DB.prepare(`UPDATE jobs SET state = ?, result_key = ?, result_hash = ?, result_meta_json = ?, lease_until = NULL
      WHERE id = ? AND device_id = ? AND lease_id = ? AND state = 'running'
        AND lease_until > CURRENT_TIMESTAMP`).bind(state, key, resultHash, resultMeta(body.result), body.jobId, device.id, body.leaseId),
    env.DB.prepare(`INSERT INTO outbox (job_id) SELECT id FROM jobs
      WHERE id = ? AND device_id = ? AND lease_id = ? AND result_hash = ? AND state = ?`)
      .bind(body.jobId, device.id, body.leaseId, resultHash, state),
  ];
  if (state === 'completed') {
    // The agent finished a turn that carried the thread's earlier unrun
    // requests; later turns no longer need them.
    statements.push(env.DB.prepare(`UPDATE jobs SET handed_to_agent_at = CURRENT_TIMESTAMP
      WHERE id IN (${EARLIER_REQUESTS})
        AND EXISTS (SELECT 1 FROM jobs WHERE id = ?1 AND device_id = ?2 AND lease_id = ?3 AND result_hash = ?4 AND state = 'completed')`)
      .bind(body.jobId, device.id, body.leaseId, resultHash));
  }
  // Every reply is charged whatever its outcome; the charge was reserved
  // when the email arrived.
  if (reactionStatus && env.STATUS_REACTIONS_ENABLED === 'true') {
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO status_reactions (job_id, status)
      SELECT j.id, ? FROM jobs j JOIN messages m ON m.id = j.message_id
      WHERE j.id = ? AND j.device_id = ? AND j.lease_id = ? AND j.result_hash = ?
        AND j.state = ? AND m.sender_email LIKE '%@gmail.com'
        AND (SELECT status_reactions FROM accounts WHERE id = ?) = 1`)
      .bind(reactionStatus, body.jobId, device.id, body.leaseId, resultHash, state, device.account_id));
  }
  // Follow-ups the run never took become ordinary queued jobs behind it.
  statements.push(env.DB.prepare(`UPDATE jobs SET state = 'queued', steer_state = NULL
    WHERE steer_of = ? AND steer_state = 'pending'
      AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND lease_id = ? AND result_hash = ? AND state IN ('completed', 'failed'))`)
    .bind(body.jobId, body.jobId, body.leaseId, resultHash));
  const updated = await env.DB.batch(statements);
  if ((updated[1].meta?.changes ?? updated[1].changes) !== 1) return json({ error: 'Lease expired or replaced' }, 409);
  return json({ completed: true, duplicate: false, ...(sealed ? { reply: await sendSealedReply(env, body.jobId, body, files) } : {}) });
}

export async function handleDeviceRequest(request, env) {
  const url = new URL(request.url);
  if (!((request.method === 'GET' && ['/api/device/attachment', '/api/device/status', '/api/device/push'].includes(url.pathname)) ||
    (request.method === 'GET' && url.pathname === '/api/device/pending-sends') ||
    (request.method === 'POST' && ['/api/device/claim', '/api/device/renew', '/api/device/steered', '/api/device/started', '/api/device/complete', '/api/device/artifacts', '/api/device/models', '/api/device/projects', '/api/device/file-route', '/api/device/key', '/api/device/send'].includes(url.pathname)))) {
    return new Response('Not found', { status: 404 });
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) return json({ error: 'HTTPS required' }, 403);
  if (!env.DB || !env.MAIL) throw new Error('Device job bindings are incomplete');
  const device = await deviceFor(request, env);
  // Only failed tokens count, so a guessing client is slowed and paired devices never are.
  if (!device) return await rateLimited(env, 'AUTH_RATE_LIMIT', request, 'device')
    ? tooManyRequests() : json({ error: 'Unauthorized device' }, 401);
  if (url.pathname === '/api/device/status') return Response.json({ paired: true }, {
    headers: { 'Cache-Control': 'no-store' },
  });
  if (url.pathname === '/api/device/push') return openDevicePush(request, env, device);
  if (url.pathname === '/api/device/attachment') return attachment(request, env, device, url);
  if (url.pathname === '/api/device/claim') return claim(env, device, await busyFolders(request));
  if (url.pathname === '/api/device/artifacts') return uploadRunArtifact(request, env, device);
  if (url.pathname === '/api/device/pending-sends') return json({ replies: await heldReplies(env, device) });
  let body;
  const large = device.key_id && ['/api/device/complete', '/api/device/send'].includes(url.pathname);
  try { body = await boundedJson(request, large ? MAX_SEALED_BODY_BYTES : MAX_RESULT_BYTES); }
  catch { return json({ error: 'Invalid or oversized JSON body' }, 400); }
  if (url.pathname === '/api/device/key') {
    // The public half of this computer's sealing key; new mail for it is
    // stored sealed to it. Re-registering the same key changes nothing.
    const keyId = await registerDeviceKey(env.DB, device, body?.publicKey);
    return keyId ? json({ saved: true, keyId }) : json({ error: 'Invalid public key' }, 400);
  }
  if (url.pathname === '/api/device/send') {
    if (!ARTIFACT_ID.test(body?.jobId ?? '') || !body?.payload || typeof body.payload !== 'object') return json({ error: 'Invalid reply' }, 400);
    const sent = await sendHeldReply(env, device, body.jobId, body.payload);
    return sent.state === 'mismatch' ? json({ error: 'Reply does not match the held copy' }, 409)
      : sent.state === 'none' ? json({ error: 'No held reply' }, 404)
        : json({ state: sent.state }, sent.state === 'waiting' ? 409 : 200);
  }
  if (url.pathname === '/api/device/file-route') return fileRoute(env, device, body);
  if (url.pathname === '/api/device/models') {
    let models;
    try { models = catalogFromDevice(body); }
    catch { return json({ error: 'Invalid model catalog' }, 400); }
    const defaults = deviceDefaults(body?.defaults, models);
    const limits = deviceLimits(body?.limits);
    await env.DB.prepare(`UPDATE devices SET model_catalog_json = ?, model_catalog_at = CURRENT_TIMESTAMP, defaults_json = ?,
      limits_json = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL`)
      .bind(JSON.stringify(models), defaults ? JSON.stringify(defaults) : null, limits ? JSON.stringify(limits) : null,
        device.id, device.account_id).run();
    // The computer carries the owner's reaction choice (`tagmails set --reactions on|off`); older daemons send none.
    if (typeof body?.reactions === 'boolean') {
      await env.DB.prepare('UPDATE accounts SET status_reactions = ? WHERE id = ?').bind(body.reactions ? 1 : 0, device.account_id).run();
    }
    return json({ saved: true, count: models.length });
  }
  if (url.pathname === '/api/device/projects') {
    let projects;
    try { projects = cleanProjectCatalog(body?.projects); }
    catch { return json({ error: 'Invalid project list' }, 400); }
    await env.DB.prepare(`UPDATE devices SET project_catalog_json = ?, project_catalog_at = CURRENT_TIMESTAMP
      WHERE id = ? AND account_id = ? AND revoked_at IS NULL`)
      .bind(projects.length ? await sealText(env, JSON.stringify(projects)) : null, device.id, device.account_id).run();
    return json({ saved: true, count: projects.length });
  }
  if (url.pathname === '/api/device/renew') return renew(env, device, body);
  if (url.pathname === '/api/device/steered') return steered(env, device, body);
  return url.pathname === '/api/device/started' ? started(env, device, body) : complete(env, device, body);
}
