import { randomUUID } from 'node:crypto';
import { Resend } from 'resend';
import { chooseModel } from '../apps/mock-inbox/model.mjs';
import { inspectResendInbound } from './resend-inbound.mjs';
import { handleDeviceRequest } from './device-jobs.mjs';
import { reconcileOneUnknownOutbox, reconcileSentEvent, sendNextOutbox } from './outbox.mjs';
import { handleAccountRequest } from './account-auth.mjs';
import { accountPage } from './account-page.mjs';
import { handleTestWalletRequest, reconcileDueRefunds } from './billing-wallet.mjs';
import { fundPendingTestEmails, reconcileTestEmailCharges, reservePendingTestEmails,
  testBillingEnabled } from './email-charges.mjs';
import { deleteExpiredRunArtifacts } from './run-artifacts.mjs';
import { deleteSettledInboundMime } from './inbound-retention.mjs';

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

function visibleGuests(message, owner, agent) {
  const guests = [...new Set([...(message.to ?? []), ...(message.cc ?? [])])]
    .filter((email) => email !== owner && email !== agent);
  if (guests.length > 20 || guests.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new Error('Owner email has too many or invalid visible participants');
  }
  return guests;
}

async function resolveAgentAddress(db, candidates) {
  if (!candidates.length) return null;
  const placeholders = candidates.map(() => '?').join(', ');
  const rows = await db.prepare(`SELECT agent_email FROM accounts
    WHERE active = 1 AND agent_email IN (${placeholders})`).bind(...candidates).all();
  const accounts = rows.results ?? rows;
  return accounts.length === 1 ? accounts[0].agent_email : null;
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

export async function handleInbound(request, env, { inspect = inspectResendInbound, getReceivedEmail = (id) => receivedEmail(env, id), fetchRaw = fetch } = {}) {
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
  const agent = (message.agentAddress ?? '').trim().toLowerCase();
  const account = await env.DB.prepare('SELECT id, owner_email, default_model FROM accounts WHERE agent_email = ? AND active = 1')
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
  const id = randomUUID();
  const newThreadId = threadId ?? randomUUID();
  const guests = owner ? visibleGuests(message, ownerEmail, agent) : [];
  const objectKey = `inbound/${account.id}/${message.providerEmailId}.eml`;
  await env.MAIL.put(objectKey, message.rawMime, { httpMetadata: { contentType: 'message/rfc822' } });
  const statements = [];
  if (!threadId) statements.push(env.DB.prepare('INSERT INTO threads (id, account_id, subject) VALUES (?, ?, ?)')
    .bind(newThreadId, account.id, message.subject.slice(0, 300)));
  statements.push(env.DB.prepare(`INSERT INTO messages
    (id, account_id, thread_id, provider_email_id, message_id, direction, sender_email, object_key)
    VALUES (?, ?, ?, ?, ?, 'inbound', ?, ?)`).bind(id, account.id, newThreadId, message.providerEmailId, message.messageId, message.from, objectKey));
  for (const guest of guests) {
    statements.push(env.DB.prepare(`INSERT INTO participants (thread_id, email) VALUES (?, ?)
      ON CONFLICT(thread_id, email) DO UPDATE SET revoked_at = NULL`).bind(newThreadId, guest));
  }
  const jobId = randomUUID();
  statements.push(env.DB.prepare("INSERT INTO jobs (id, thread_id, message_id, state, model_json) VALUES (?, ?, ?, 'queued', ?)")
    .bind(jobId, newThreadId, id, JSON.stringify(chooseModel(message.body, account.default_model))));
  try {
    await env.DB.batch(statements);
  } catch (error) {
    // A concurrent delivery may have committed the same provider email first.
    const raced = await env.DB.prepare('SELECT id FROM messages WHERE account_id = ? AND (provider_email_id = ? OR message_id = ?) LIMIT 1')
      .bind(account.id, message.providerEmailId, message.messageId).first();
    if (raced) return Response.json({ accepted: true, duplicate: true });
    throw error;
  }
  if (testBillingEnabled(env)) {
    try { await reservePendingTestEmails(env, account.id); }
    catch { console.error('Test email credit reservation is delayed'); }
    const charge = await env.DB.prepare('SELECT job_id FROM test_email_charges WHERE job_id = ? AND state = ?')
      .bind(jobId, 'reserved').first();
    return Response.json({ accepted: true, duplicate: false, awaitingCredits: !charge });
  }
  return Response.json({ accepted: true, duplicate: false });
}

export default {
  async fetch(request, env) {
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
    try { return await handleInbound(request, env); }
    catch { return new Response('Inbound mail could not be accepted', { status: 500 }); }
  },
  async scheduled(_event, env) {
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
    for (let index = 0; index < 10; index += 1) {
      const result = await sendNextOutbox(env);
      if (['idle', 'contended', 'accepted'].includes(result.state)) break;
    }
  },
};
