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
  const message = await inspectResendInbound({ ...options(item), fetchRaw: async (url, request) => {
    assert.equal(url, item.email.raw.download_url);
    assert.equal(request.redirect, 'error');
    return new Response(item.raw, { status: 200 });
  } });
  assert.equal(message.providerEmailId, id);
  assert.equal(message.eventId, 'msg_synthetic_event_1');
  assert.equal(message.from, 'owner@gmail.com');
  assert.deepEqual(message.cc, ['teammate@gmail.com']);
  assert.deepEqual(message.bcc, []);
  assert.match(message.body, /launch copy/);
  assert.equal(message.rawMime.toString(), item.raw);
});

test('a signed sent event carries the job tag and provider identifiers', async () => {
  const item = fixture();
  const jobId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const event = signed({ type: 'email.sent', data: {
    email_id: id, message_id: '<sent@resend.dev>', from: agent,
    to: ['owner@gmail.com'], cc: [], subject: 'Re: Shared review',
    tags: { tagmails_job: jobId },
  } });
  assert.deepEqual(await inspectResendInbound({ ...options(item), ...event }), { sent: {
    jobId, providerEmailId: id, messageId: '<sent@resend.dev>', from: agent,
    to: ['owner@gmail.com'], cc: [], subject: 'Re: Shared review',
  } });
  await assert.rejects(inspectResendInbound({ ...options(item), ...event,
    rawPayload: event.rawPayload + ' ' }));
});

test('a signed delivery event identifies one recipient without treating it as a new email', async () => {
  const item = fixture();
  const jobId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const createdAt = '2026-10-03T10:00:00.000Z';
  const event = signed({ type: 'email.bounced', created_at: createdAt, data: {
    email_id: id, message_id: '<sent@resend.dev>', from: agent,
    to: ['Guest <guest@gmail.com>'], subject: 'Re: Shared review',
    tags: { tagmails_job: jobId }, bounce: { type: 'Permanent', message: 'Unknown recipient' },
  } });
  assert.deepEqual(await inspectResendInbound({ ...options(item), ...event }), { deliveryOutcome: {
    jobId, providerEmailId: id, recipient: 'guest@gmail.com', from: agent,
    subject: 'Re: Shared review', status: 'bounced', eventAt: createdAt,
    eventId: 'msg_synthetic_event_1',
  } });
  await assert.rejects(inspectResendInbound({ ...options(item), ...event,
    rawPayload: event.rawPayload + ' ' }));
});

test('verified delivery accepts an agent who was Bcc on its own provider copy', async () => {
  const item = fixture({ hiddenAgent: true });
  const message = await inspectResendInbound(options(item));
  assert.equal(message.messageId, messageId);
  assert.deepEqual(message.bcc, []);
});

test('a p=none sender needs aligned DKIM when Resend reports gray DMARC', async () => {
  const item = fixture();
  const gray = { ...item.email, authentication: { dmarc: 'gray', spf: 'pass', dkim: 'pass' } };
  assert.equal((await inspectResendInbound({ ...options(item), getReceivedEmail: async () => gray })).from,
    'owner@gmail.com');
  await assert.rejects(inspectResendInbound({ ...options(item), getReceivedEmail: async () => ({
    ...gray, authentication: { dmarc: 'gray', spf: 'pass', dkim: 'gray' },
  }) }), /DMARC or aligned DKIM/);
});

test('a verified event resolves one active agent address before retrieving mail', async () => {
  const item = fixture();
  let candidates;
  const optionsWithResolver = { ...options(item), agentAddress: undefined,
    resolveAgentAddress: async (addresses) => { candidates = addresses; return agent; } };
  const message = await inspectResendInbound(optionsWithResolver);
  assert.equal(message.agentAddress, agent);
  assert.deepEqual(candidates, [agent, 'teammate@gmail.com']);
  assert.deepEqual(await inspectResendInbound({ ...optionsWithResolver,
    resolveAgentAddress: async () => null,
    getReceivedEmail: async () => { throw new Error('Unmatched mail must not be fetched'); },
  }), { ignored: true });
  await assert.rejects(inspectResendInbound({ ...optionsWithResolver,
    resolveAgentAddress: async () => 'other@wonder.test',
  }), /does not identify/);
});

test('a Received-header recipient alone cannot route mail to an agent', async () => {
  const item = fixture();
  const payload = JSON.parse(item.rawPayload);
  payload.data.to = ['other@example.test'];
  payload.data.cc = [];
  payload.data.bcc = [];
  payload.data.received_for = [agent];
  let candidates;
  assert.deepEqual(await inspectResendInbound({ ...options(item), ...signed(payload), agentAddress: undefined,
    resolveAgentAddress: async (addresses) => { candidates = addresses; return null; },
    getReceivedEmail: async () => { throw new Error('Unmatched mail must not be fetched'); },
  }), { ignored: true });
  assert.deepEqual(candidates, ['other@example.test']);

  await assert.rejects(inspectResendInbound({ ...options(item), getReceivedEmail: async () => ({
    ...item.email, to: ['other@example.test'], cc: [], bcc: [], received_for: [agent],
  }) }), /does not match the verified event/);
});

test('Resend intake rejects tampering, mismatched retrieval, failed authentication, and unsafe raw URLs', async () => {
  const item = fixture();
  await assert.rejects(inspectResendInbound({ ...options(item), rawPayload: item.rawPayload + ' ' }));
  await assert.rejects(inspectResendInbound({ ...options(item), getReceivedEmail: async () => ({ ...item.email, message_id: '<different@example.test>' }) }), /does not match/);
  await assert.rejects(inspectResendInbound({ ...options(item), getReceivedEmail: async () => ({ ...item.email, authentication: { dmarc: 'fail' } }) }), /DMARC/);
  await assert.rejects(inspectResendInbound({ ...options(item), getReceivedEmail: async () => ({ ...item.email, raw: { download_url: 'https://attacker.example/raw' } }) }), /outside the provider domain/);
});
