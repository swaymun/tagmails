import { randomUUID } from 'node:crypto';
import { Resend } from 'resend';
import { routeModel } from './jev-route.mjs';
import { inspectResendInbound } from './resend-inbound.mjs';
import { knownAgentAddresses } from './agent-addresses.mjs';
import { handleDeviceRequest } from './device-jobs.mjs';
import { reconcileOneUnknownOutbox, reconcileSentEvent, recordDeliveryOutcome, sendNextOutbox } from './outbox.mjs';
import { handleAccountRequest } from './account-auth.mjs';
import { accountPage } from './account-page.mjs';
import { handleTestWalletRequest, reconcileDueRefunds } from './billing-wallet.mjs';
import { fundPendingTestEmails, reconcileTestEmailCharges, reservePendingTestEmails,
  testBillingEnabled } from './email-charges.mjs';
import { deleteExpiredRunArtifacts } from './run-artifacts.mjs';
import { deleteSettledInboundMime } from './inbound-retention.mjs';
import { sendNextStatusReaction } from './status-reactions.mjs';

const MAX_WEBHOOK_BYTES = 128_000;

async function boundedWebhook(request) {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_WEBHOOK_BYTES) {
        await reader.cancel();
        throw new Error('Webhook too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function receivedEmail(env, emailId) {
  const { data, error } = await new Resend(env.RESEND_API_KEY).emails.receiving.get(emailId);
  if (error || !data) throw new Error('Resend could not retrieve the received email');
  return data;
}

async function parentThread(db, accountId, parentIds) {
  for (const messageId of parentIds.slice(-50).reverse()) {
    const row = await db.prepare(`SELECT m.thread_id FROM messages m
      JOIN threads t ON t.id = m.thread_id
      WHERE t.account_id = ? AND m.message_id = ? LIMIT 1`).bind(accountId, messageId).first();
    if (row) return row.thread_id;
  }
  return null;
}

function visibleGuests(message, owner, agentAddresses) {
  const guests = [...new Set([...(message.to ?? []), ...(message.cc ?? [])])]
    .filter((email) => email !== owner && !agentAddresses.has(email));
  if (guests.length > 20 || guests.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new Error('Owner email has too many or invalid visible participants');
  }
  return guests;
}

export async function completeOneModelClarification(env) {
  const row = await env.DB.prepare(`SELECT j.id, t.account_id,
      json_extract(j.model_json, '$.error') AS error
    FROM jobs j JOIN threads t ON t.id = j.thread_id
    JOIN accounts a ON a.id = t.account_id
    JOIN messages m ON m.id = j.message_id
    WHERE j.state = 'queued' AND a.active = 1
      AND json_type(j.model_json, '$.error') = 'text'
      AND (m.sender_email = a.owner_email OR EXISTS (
        SELECT 1 FROM participants p WHERE p.thread_id = t.id
          AND p.email = m.sender_email AND p.revoked_at IS NULL))
    ORDER BY j.created_at, j.rowid LIMIT 1`).bind().first();
  if (!row) return false;
  const key = `results/${row.account_id}/${row.id}/model-clarification.json`;
  const result = { runtime: 'relay', state: 'needs_clarification', summary: row.error,
    checks: ['No local agent ran and no task credit was charged.'] };
  await env.MAIL.put(key, JSON.stringify(result), { httpMetadata: { contentType: 'application/json' } });
  const [updated] = await env.DB.batch([
    env.DB.prepare(`UPDATE jobs SET state = 'completed', result_key = ?
      WHERE id = ? AND state = 'queued' AND json_extract(model_json, '$.error') = ?`)
      .bind(key, row.id, row.error),
    env.DB.prepare(`INSERT OR IGNORE INTO outbox (job_id)
      SELECT id FROM jobs WHERE id = ? AND state = 'completed' AND result_key = ?`)
      .bind(row.id, key),
  ]);
  return (updated.meta?.changes ?? updated.changes) === 1;
}

async function resolveAgentAddress(db, candidates) {
  if (!candidates.length) return null;
  const placeholders = candidates.map(() => '?').join(', ');
  const rows = await db.prepare(`SELECT aa.email, aa.account_id, a.agent_email
    FROM account_agent_addresses aa JOIN accounts a ON a.id = aa.account_id
    WHERE a.active = 1 AND aa.email IN (${placeholders})`).bind(...candidates).all();
  const matches = rows.results ?? rows;
  if (new Set(matches.map((row) => row.account_id)).size !== 1) return null;
  return matches.find((row) => row.email === row.agent_email)?.email ?? matches[0]?.email ?? null;
}

async function recordReaction(env, account, message) {
  const prior = await env.DB.prepare(`SELECT id FROM reactions
    WHERE account_id = ? AND (provider_email_id = ? OR message_id = ?) LIMIT 1`)
    .bind(account.id, message.providerEmailId, message.messageId).first();
  if (prior) return Response.json({ accepted: true, reaction: true, duplicate: true });
  const target = await env.DB.prepare(`SELECT m.id, m.thread_id, o.payload_json FROM messages m
    JOIN outbox o ON o.provider_email_id = m.provider_email_id
    WHERE m.account_id = ? AND m.message_id = ? AND m.direction = 'outbound' LIMIT 1`)
    .bind(account.id, message.reactionTargetId).first();
  if (!target) return Response.json({ accepted: false, reaction: true });
  const payload = JSON.parse(target.payload_json);
  const recipients = [...payload.to, ...(payload.cc ?? [])];
  if (!recipients.includes(message.from)) return Response.json({ accepted: false, reaction: true });
  if (message.from !== account.owner_email.toLowerCase()) {
    const participant = await env.DB.prepare('SELECT email FROM participants WHERE thread_id = ? AND email = ? AND revoked_at IS NULL')
      .bind(target.thread_id, message.from).first();
    if (!participant) return Response.json({ accepted: false, reaction: true });
  }
  try {
    await env.DB.prepare(`INSERT INTO reactions
      (id, account_id, target_message_id, provider_email_id, message_id, sender_email, emoji)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(randomUUID(), account.id, target.id,
      message.providerEmailId, message.messageId, message.from, message.reaction).run();
  } catch (error) {
    const raced = await env.DB.prepare(`SELECT id FROM reactions
      WHERE account_id = ? AND (provider_email_id = ? OR message_id = ?) LIMIT 1`)
      .bind(account.id, message.providerEmailId, message.messageId).first();
    if (raced) return Response.json({ accepted: true, reaction: true, duplicate: true });
    throw error;
  }
  return Response.json({ accepted: true, reaction: true, duplicate: false });
}

export async function handleInbound(request, env, { inspect = inspectResendInbound, getReceivedEmail = (id) => receivedEmail(env, id), fetchRaw = fetch, fetchModel = fetch } = {}) {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/webhooks/resend') return new Response('Not found', { status: 404 });
  if (!env.DB || !env.MAIL || !env.RESEND_WEBHOOK_SECRET || !env.RESEND_API_KEY) {
    throw new Error('Resend relay bindings and secrets are incomplete');
  }
  if (Number(request.headers.get('content-length') || 0) > MAX_WEBHOOK_BYTES) return new Response('Webhook too large', { status: 413 });
  let rawPayload;
  try { rawPayload = await boundedWebhook(request); }
  catch (error) {
    if (error.message === 'Webhook too large') return new Response('Webhook too large', { status: 413 });
    throw error;
  }
  const message = await inspect({
    rawPayload, headers: request.headers, webhookSecret: env.RESEND_WEBHOOK_SECRET,
    apiKey: env.RESEND_API_KEY,
    resolveAgentAddress: (candidates) => resolveAgentAddress(env.DB, candidates),
    getReceivedEmail, fetchRaw,
  });
  if (message.ignored) return Response.json({ accepted: false });
  if (message.sent) return Response.json(await reconcileSentEvent(env, message.sent));
  if (message.deliveryOutcome) return Response.json(await recordDeliveryOutcome(env, message.deliveryOutcome));
  const agent = (message.agentAddress ?? '').trim().toLowerCase();
  const account = await env.DB.prepare(`SELECT a.id, a.owner_email,
    COALESCE(p.default_model, a.default_model) AS default_model,
    COALESCE(p.default_effort, 'medium') AS default_effort,
    COALESCE(p.default_speed, 'standard') AS default_speed
    FROM account_agent_addresses aa JOIN accounts a ON a.id = aa.account_id
    LEFT JOIN account_preferences p ON p.account_id = a.id
    WHERE aa.email = ? AND a.active = 1`)
    .bind(agent).first();
  if (!account) return Response.json({ accepted: false });
  const duplicate = await env.DB.prepare('SELECT id FROM messages WHERE account_id = ? AND (provider_email_id = ? OR message_id = ?) LIMIT 1')
    .bind(account.id, message.providerEmailId, message.messageId).first();
  if (duplicate) {
    if (testBillingEnabled(env)) {
      try { await reservePendingTestEmails(env, account.id); }
      catch (error) { console.error('Test email reservation failed', error); }
    }
    return Response.json({ accepted: true, duplicate: true });
  }
  if (message.reaction) return recordReaction(env, account, message);

  const ownerEmail = account.owner_email.toLowerCase();
  const owner = message.from === ownerEmail;
  const threadId = await parentThread(env.DB, account.id, message.parentIds ?? []);
  if (!owner) {
    if (!threadId) return Response.json({ accepted: false });
    const participant = await env.DB.prepare('SELECT email FROM participants WHERE thread_id = ? AND email = ? AND revoked_at IS NULL')
      .bind(threadId, message.from).first();
    if (!participant) return Response.json({ accepted: false });
  }
  const priorDevice = threadId ? await env.DB.prepare(`SELECT d.revoked_at FROM threads t
    LEFT JOIN devices d ON d.id = t.device_id WHERE t.id = ? AND t.account_id = ?`)
    .bind(threadId, account.id).first() : null;
  const threadUnavailable = Boolean(priorDevice?.revoked_at);
  const id = randomUUID();
  const newThreadId = threadId ?? randomUUID();
  const recipients = [...(message.to ?? []), ...(message.cc ?? [])];
  const agentAddresses = owner ? await knownAgentAddresses(env.DB, recipients) : null;
  const guests = owner ? visibleGuests(message, ownerEmail, agentAddresses) : [];
  const objectKey = `inbound/${account.id}/${message.providerEmailId}.eml`;
  await env.MAIL.put(objectKey, message.rawMime, { httpMetadata: { contentType: 'message/rfc822' } });
  const statements = [];
  if (!threadId) statements.push(env.DB.prepare('INSERT INTO threads (id, account_id, subject) VALUES (?, ?, ?)')
    .bind(newThreadId, account.id, message.subject.slice(0, 300)));
  statements.push(env.DB.prepare(`INSERT INTO messages
    (id, account_id, thread_id, provider_email_id, message_id, direction, sender_email, object_key, agent_email)
    VALUES (?, ?, ?, ?, ?, 'inbound', ?, ?, ?)`).bind(id, account.id, newThreadId, message.providerEmailId, message.messageId, message.from, objectKey, agent));
  for (const guest of guests) {
    statements.push(env.DB.prepare(`INSERT INTO participants (thread_id, email) VALUES (?, ?)
      ON CONFLICT(thread_id, email) DO UPDATE SET revoked_at = NULL`).bind(newThreadId, guest));
  }
  const jobId = randomUUID();
  const previousJob = threadId && !threadUnavailable ? await env.DB.prepare(`SELECT j.model_json FROM jobs j
    JOIN messages m ON m.id = j.message_id
    WHERE j.thread_id = ? AND json_extract(j.model_json, '$.id') IS NOT NULL
    ORDER BY m.rowid DESC LIMIT 1`).bind(threadId).first() : null;
  const priorModel = previousJob?.model_json ? JSON.parse(previousJob.model_json) : null;
  let model = threadUnavailable ? null : await routeModel(message.body, account.default_model, {
    apiKey: env.TYPESAFE_API_KEY, fetcher: fetchModel, priorModel, subject: message.subject,
    pilotCodexModel: env.PILOT_CODEX_MODEL,
    defaultEffort: account.default_effort, defaultSpeed: account.default_speed,
  });
  if (model?.id === 'claude-sonnet-5-5' && env.CLAUDE_ROUTE_ENABLED !== 'true') {
    model = { error: 'Claude Code is unavailable in this pilot. Please ask for Codex or Luna.' };
  }
  const unavailableResult = threadUnavailable ? {
    runtime: 'relay', state: 'failed',
    summary: owner
      ? 'This thread\'s Mac was revoked, so the task did not run. Start a new email to your agent address to begin a new session.'
      : 'This thread\'s Mac was revoked, so the task did not run. Ask the account owner to start a new email thread with you.',
    checks: ['No local agent ran and no task credit was charged.'],
  } : null;
  const resultKey = unavailableResult ? `results/${account.id}/${jobId}/unavailable.json` : null;
  if (unavailableResult) await env.MAIL.put(resultKey, JSON.stringify(unavailableResult), {
    httpMetadata: { contentType: 'application/json' },
  });
  statements.push(env.DB.prepare('INSERT INTO jobs (id, thread_id, message_id, state, model_json, result_key) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(jobId, newThreadId, id, threadUnavailable ? 'failed' : 'queued', model && JSON.stringify(model), resultKey));
  if (!threadUnavailable && !model?.error && env.STATUS_REACTIONS_ENABLED === 'true' &&
      !env.RESEND_TEST_FROM && message.from.endsWith('@gmail.com')) {
    statements.push(env.DB.prepare("INSERT INTO status_reactions (job_id, status) VALUES (?, 'received')").bind(jobId));
  }
  if (threadUnavailable) statements.push(env.DB.prepare('INSERT INTO outbox (job_id) VALUES (?)').bind(jobId));
  try {
    await env.DB.batch(statements);
  } catch (error) {
    // A concurrent delivery may have committed the same provider email first.
    const raced = await env.DB.prepare('SELECT id FROM messages WHERE account_id = ? AND (provider_email_id = ? OR message_id = ?) LIMIT 1')
      .bind(account.id, message.providerEmailId, message.messageId).first();
    if (raced) return Response.json({ accepted: true, duplicate: true });
    throw error;
  }
  if (threadUnavailable) return Response.json({ accepted: true, duplicate: false, threadUnavailable: true });
  if (testBillingEnabled(env)) {
    try { await reservePendingTestEmails(env, account.id); }
    catch { console.error('Test email credit reservation is delayed'); }
    const charge = await env.DB.prepare('SELECT job_id FROM test_email_charges WHERE job_id = ? AND state = ?')
      .bind(jobId, 'reserved').first();
    return Response.json({ accepted: true, duplicate: false, awaitingCredits: !model.error && !charge });
  }
  return Response.json({ accepted: true, duplicate: false });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'GET' && new URL(request.url).pathname === '/account') return accountPage();
    try {
      const billing = await handleTestWalletRequest(request, env);
      if (billing) return billing;
    } catch { return new Response('Test wallet request failed', { status: 500 }); }
    try {
      const account = await handleAccountRequest(request, env);
      if (account) return account;
    } catch { return new Response('Account request failed', { status: 500 }); }
    if (new URL(request.url).pathname.startsWith('/api/device/')) {
      try { return await handleDeviceRequest(request, env); }
      catch { return new Response('Device job request failed', { status: 500 }); }
    }
    try {
      const response = await handleInbound(request, env);
      if (ctx && response.ok && env.STATUS_REACTIONS_ENABLED === 'true') {
        ctx.waitUntil(sendNextStatusReaction(env).catch(() => console.error('Status reaction is delayed')));
      }
      return response;
    }
    catch (error) {
      console.error('Inbound mail intake failed:', error instanceof Error ? error.message : 'Unknown error');
      return new Response('Inbound mail could not be accepted', { status: 500 });
    }
  },
  async scheduled(_event, env) {
    try {
      for (let index = 0; index < 10; index += 1) {
        if (!await completeOneModelClarification(env)) break;
      }
    } catch { console.error('Model clarification is delayed'); }
    try { await deleteSettledInboundMime(env); }
    catch { console.error('Inbound MIME cleanup is delayed'); }
    try { await deleteExpiredRunArtifacts(env); }
    catch { console.error('Run artifact cleanup is delayed'); }
    try { await reconcileDueRefunds(env); }
    catch { console.error('Test wallet refund reconciliation is delayed'); }
    try { await reconcileTestEmailCharges(env); await fundPendingTestEmails(env); }
    catch { console.error('Test email credit reconciliation is delayed'); }
    try { await reconcileOneUnknownOutbox(env); }
    catch { console.error('Uncertain outbound reconciliation is delayed'); }
    try {
      for (let index = 0; index < 10; index += 1) {
        const reaction = await sendNextStatusReaction(env);
        if (['idle', 'disabled', 'contended', 'uncertain'].includes(reaction.state)) break;
      }
    } catch { console.error('Status reaction send is delayed'); }
    for (let index = 0; index < 10; index += 1) {
      const result = await sendNextOutbox(env);
      if (['idle', 'contended'].includes(result.state)) break;
    }
  },
};
