import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { inspectResendInbound } from './resend-inbound.mjs';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const messageId = '<owner-message@example.test>';
const agent = 'agent@wonder.test';
const secret = `whsec_${Buffer.from('synthetic-webhook-secret-for-tests').toString('base64')}`;

function signed(payload) {
  const rawPayload = JSON.stringify(payload);
  const eventId = 'msg_synthetic_event_1';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
    .update(`${eventId}.${timestamp}.${rawPayload}`).digest('base64');
  return { rawPayload, headers: { 'svix-id': eventId, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` } };
}

function fixture({ hiddenAgent = false } = {}) {
  const recipient = hiddenAgent ? 'teammate@gmail.com' : agent;
  const raw = [
    'From: Owner <owner@gmail.com>', `To: ${recipient}`,
    'Cc: teammate@gmail.com', 'Bcc: hidden@gmail.com',
    'Subject: Shared review', `Message-ID: ${messageId}`,
    'Content-Type: text/plain; charset=utf-8', '', 'Please review the launch copy.',
  ].join('\r\n');
  const metadata = {
    email_id: id, message_id: messageId, from: 'Owner <owner@gmail.com>',
    to: [recipient], cc: ['teammate@gmail.com'], bcc: hiddenAgent ? [agent] : [],
  };
  const email = {
    id, message_id: messageId, from: 'owner@gmail.com',
    to: metadata.to, cc: metadata.cc, bcc: metadata.bcc,
    authentication: { dmarc: 'pass', spf: 'pass', dkim: 'pass' },
    raw: { download_url: 'https://inbound.resend.com/raw/synthetic' },
  };
  const event = { type: 'email.received', created_at: new Date().toISOString(), data: metadata };
  return { ...signed(event), email, raw };
}

function options(item) {
  return {
    rawPayload: item.rawPayload, headers: item.headers, webhookSecret: secret,
    apiKey: 're_synthetic_test_key', agentAddress: agent,
    getReceivedEmail: async () => item.email,
    fetchRaw: async () => new Response(item.raw, { status: 200 }),
  };
}

test('verified Resend metadata and raw MIME yield a task without granting unobservable Bcc guests', async () => {
  const item = fixture();
  const message = await inspectResendInbound(options(item));
  assert.equal(message.providerEmailId, id);
  assert.equal(message.eventId, 'msg_synthetic_event_1');
  assert.equal(message.from, 'owner@gmail.com');
  assert.deepEqual(message.cc, ['teammate@gmail.com']);
  assert.deepEqual(message.bcc, []);
  assert.match(message.body, /launch copy/);
});

test('verified delivery accepts an agent who was Bcc on its own provider copy', async () => {
  const item = fixture({ hiddenAgent: true });
  const message = await inspectResendInbound(options(item));
  assert.equal(message.messageId, messageId);
  assert.deepEqual(message.bcc, []);
});

test('Resend intake rejects tampering, mismatched retrieval, failed authentication, and unsafe raw URLs', async () => {
  const item = fixture();
  await assert.rejects(inspectResendInbound({ ...options(item), rawPayload: item.rawPayload + ' ' }));
  await assert.rejects(inspectResendInbound({ ...options(item), getReceivedEmail: async () => ({ ...item.email, message_id: '<different@example.test>' }) }), /does not match/);
  await assert.rejects(inspectResendInbound({ ...options(item), getReceivedEmail: async () => ({ ...item.email, authentication: { dmarc: 'fail' } }) }), /DMARC/);
  await assert.rejects(inspectResendInbound({ ...options(item), getReceivedEmail: async () => ({ ...item.email, raw: { download_url: 'https://attacker.example/raw' } }) }), /outside the provider domain/);
});
