import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import { bindings } from './bindings-fixture.mjs';
import { completeOneModelClarification, handleInbound } from './relay-worker.mjs';
import { handleDeviceRequest } from './device-jobs.mjs';
import { handleAccountRequest } from './account-auth.mjs';
import { recordDeliveryOutcome, sendNextOutbox } from './outbox.mjs';
import { handleTestWalletRequest } from './billing-wallet.mjs';
import { reconcileTestEmailCharges, reservePendingTestEmails, testWalletSnapshot } from './email-charges.mjs';

function pilot() {
  const fixture = bindings();
  fixture.env.BILLING_TEST_MODE = 'true';
  fixture.env.STRIPE_SECRET_KEY = 'sk_test_local';
  fixture.env.STRIPE_WEBHOOK_SECRET = 'whsec_local';
  return fixture;
}

function credit(sqlite, accountId, amount, suffix) {
  const checkout = `checkout-${suffix}`;
  sqlite.prepare('INSERT INTO billing_checkouts (id, account_id, amount_cents) VALUES (?, ?, 1000)')
    .run(checkout, accountId);
  sqlite.prepare(`INSERT INTO credit_ledger (id, account_id, checkout_id, amount_cents, kind, source_id)
    VALUES (?, ?, ?, ?, 'test_top_up', ?)`).run(`ledger-${suffix}`, accountId, checkout, amount, `topup-${suffix}`);
}

async function deliver(env, id, from = 'owner@gmail.com', overrides = {}) {
  const agentAddress = overrides.agentAddress ?? 'agent@wonder.test';
  const messageId = `<${id}@gmail.com>`;
  const body = overrides.body ?? 'Check this.';
  const rawMime = Buffer.from([
    `From: ${from}`, `To: ${agentAddress}`, 'Subject: Pilot', `Message-ID: ${messageId}`,
    'Content-Type: text/plain; charset=utf-8', '', body,
  ].join('\r\n'));
  const mail = { providerEmailId: id, messageId, from, agentAddress, to: [agentAddress], cc: [], bcc: [],
    subject: 'Pilot', body, parentIds: [], rawMime, ...overrides };
  const response = await handleInbound(new Request('https://relay.test/webhooks/resend', {
    method: 'POST', body: '{}',
  }), env, { inspect: async () => mail });
  assert.equal(response.status, 200);
  return response.json();
}

function device(sqlite) {
  const token = `tm_dev_${'A'.repeat(43)}`;
  sqlite.prepare('INSERT INTO devices (id, account_id, token_hash) VALUES (?, ?, ?)')
    .run('device-test', 'account-1', createHash('sha256').update(token).digest('hex'));
  return token;
}

async function claim(env, token) {
  const response = await handleDeviceRequest(new Request('https://relay.test/api/device/claim', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  }), env);
  assert.equal(response.status, 200);
  return response.json();
}

test('pilot credits reserve oldest queued email once, isolate accounts, and gate device claims', async () => {
  const { env, sqlite } = pilot();
  const token = device(sqlite);
  assert.deepEqual(await deliver(env, 'mail-1'), { accepted: true, duplicate: false, awaitingCredits: true });
  assert.deepEqual(await testWalletSnapshot(env, 'account-1'), { balanceCents: 0, waitingEmails: 1 });
  assert.deepEqual(await claim(env, token), { claimed: false });
  sqlite.prepare('INSERT INTO accounts (id, google_sub, owner_email, agent_email) VALUES (?, ?, ?, ?)')
    .run('account-2', 'google-2', 'other@gmail.com', 'other@tagmails.test');
  credit(sqlite, 'account-2', 10, 'other');
  assert.equal(await reservePendingTestEmails(env, 'account-1'), 0);
  assert.deepEqual(await deliver(env, 'mail-2', 'other@gmail.com', { agentAddress: 'other@tagmails.test' }),
    { accepted: true, duplicate: false, awaitingCredits: false });
  assert.deepEqual(await testWalletSnapshot(env, 'account-2'), { balanceCents: 5, waitingEmails: 0 });
  assert.deepEqual(await claim(env, token), { claimed: false });
  credit(sqlite, 'account-1', 5, 'owner');
  assert.equal(await reservePendingTestEmails(env, 'account-1'), 1);
  assert.equal(await reservePendingTestEmails(env, 'account-1'), 0);
  assert.deepEqual(await deliver(env, 'mail-1'), { accepted: true, duplicate: true });
  assert.deepEqual(await testWalletSnapshot(env, 'account-1'), { balanceCents: 0, waitingEmails: 0 });
  const claimed = await claim(env, token);
  assert.equal(claimed.claimed, true);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM test_email_charges WHERE account_id = ?').get('account-1').n, 1);
});

test('one credit funds the first turn when same-second job IDs sort in reverse order', async () => {
  const { env, sqlite } = pilot();
  const token = device(sqlite);
  assert.equal((await deliver(env, 'first')).awaitingCredits, true);
  assert.equal((await deliver(env, 'second', 'owner@gmail.com', {
    parentIds: ['<first@gmail.com>'],
  })).awaitingCredits, true);
  sqlite.prepare("UPDATE jobs SET id = 'z-first' WHERE message_id = (SELECT id FROM messages WHERE message_id = '<first@gmail.com>')").run();
  sqlite.prepare("UPDATE jobs SET id = 'a-second' WHERE message_id = (SELECT id FROM messages WHERE message_id = '<second@gmail.com>')").run();
  assert.equal(sqlite.prepare('SELECT COUNT(DISTINCT thread_id) n FROM jobs').get().n, 1);
  credit(sqlite, 'account-1', 5, 'one-turn');
  assert.equal(await reservePendingTestEmails(env, 'account-1'), 1);
  assert.equal(sqlite.prepare('SELECT job_id FROM test_email_charges').get().job_id, 'z-first');
  const claimed = await claim(env, token);
  assert.equal(claimed.claimed, true);
  assert.equal(JSON.parse(Buffer.from(claimed.payload, 'base64url').toString()).jobId, 'z-first');
});

test('an invalid model gets a free clarification reply while funded work still waits', async () => {
  const { env, sqlite } = pilot();
  const token = device(sqlite);
  assert.equal((await deliver(env, 'valid-1')).awaitingCredits, true);
  assert.equal((await deliver(env, 'invalid-1', 'owner@gmail.com', {
    body: 'Model: Not available\n\nPlease check this.',
  })).awaitingCredits, false);
  assert.deepEqual(await testWalletSnapshot(env, 'account-1'), { balanceCents: 0, waitingEmails: 1 });
  assert.deepEqual(await claim(env, token), { claimed: false });
  assert.equal(await completeOneModelClarification(env), true);
  assert.equal(await completeOneModelClarification(env), false);
  const clarification = sqlite.prepare(`SELECT j.state, j.result_key, o.state AS outbox_state
    FROM jobs j JOIN outbox o ON o.job_id = j.id
    JOIN messages m ON m.id = j.message_id WHERE m.provider_email_id = ?`).get('invalid-1');
  assert.equal(clarification.state, 'completed');
  assert.equal(clarification.outbox_state, 'queued');
  const saved = await env.MAIL.get(clarification.result_key);
  const result = JSON.parse(Buffer.from(await saved.arrayBuffer()).toString());
  assert.equal(result.runtime, 'relay');
  assert.equal(result.state, 'needs_clarification');
  assert.match(result.summary, /could not identify an available model/i);
  assert.deepEqual(await claim(env, token), { claimed: false });
  assert.equal((await sendNextOutbox(env, {
    sendEmail: async () => ({ data: { id: 'sent-clarification' } }),
    getSentEmail: async () => ({ data: { message_id: '<sent-clarification@tagmails.test>' } }),
  })).state, 'sent');
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM test_email_charges').get().n, 0);
  assert.deepEqual(await testWalletSnapshot(env, 'account-1'), { balanceCents: 0, waitingEmails: 1 });
});

test('a signed paid test Checkout funds waiting email without a duplicate debit', async () => {
  const { env, sqlite } = pilot();
  assert.equal((await deliver(env, 'mail-1')).awaitingCredits, true);
  const checkoutId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  sqlite.prepare('INSERT INTO billing_checkouts (id, account_id, amount_cents) VALUES (?, ?, 1000)')
    .run(checkoutId, 'account-1');
  const event = { id: 'evt_paid_1', livemode: false, type: 'checkout.session.completed', data: { object: {
    object: 'checkout.session', id: 'cs_test_paid_1', client_reference_id: checkoutId,
    mode: 'payment', payment_status: 'paid', amount_total: 1000,
    currency: 'usd', payment_intent: 'pi_paid_1',
  } } };
  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', env.STRIPE_WEBHOOK_SECRET)
    .update(`${timestamp}.${body}`).digest('hex');
  const request = () => new Request('https://relay.test/webhooks/stripe', {
    method: 'POST', body, headers: { 'Stripe-Signature': `t=${timestamp},v1=${signature}` },
  });
  assert.equal((await handleTestWalletRequest(request(), env)).status, 200);
  assert.deepEqual(await testWalletSnapshot(env, 'account-1'), { balanceCents: 995, waitingEmails: 0 });
  assert.equal((await handleTestWalletRequest(request(), env)).status, 200);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM test_email_charges').get().n, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM credit_ledger').get().n, 1);
  assert.deepEqual(await testWalletSnapshot(env, 'account-1'), { balanceCents: 995, waitingEmails: 0 });
});

test('provider acceptance settles a reserved charge; uncertain delivery holds it', async () => {
  const { env, sqlite } = pilot();
  credit(sqlite, 'account-1', 10, 'owner');
  await deliver(env, 'mail-1');
  await deliver(env, 'mail-2');
  const jobs = sqlite.prepare('SELECT id FROM jobs ORDER BY created_at, id').all();
  for (const [index, job] of jobs.entries()) {
    const resultKey = `results/${index}.json`;
    await env.MAIL.put(resultKey, JSON.stringify({ state: 'completed', summary: 'Done.' }));
    sqlite.prepare("UPDATE jobs SET state = 'completed', result_key = ? WHERE id = ?").run(resultKey, job.id);
    sqlite.prepare('INSERT INTO outbox (job_id) VALUES (?)').run(job.id);
  }
  const first = await sendNextOutbox(env, {
    sendEmail: async () => { throw new Error('Connection lost'); },
  });
  assert.equal(first.state, 'uncertain');
  assert.equal(sqlite.prepare('SELECT state FROM test_email_charges WHERE job_id = ?').get(first.jobId).state, 'reserved');
  const second = await sendNextOutbox(env, {
    sendEmail: async () => ({ data: { id: 'sent-2' } }),
    getSentEmail: async () => ({ data: { message_id: '<sent-2@tagmails.test>' } }),
  });
  assert.equal(second.state, 'sent');
  assert.equal(sqlite.prepare('SELECT state FROM test_email_charges WHERE job_id = ?').get(second.jobId).state, 'settled');
  assert.deepEqual(await testWalletSnapshot(env, 'account-1'), { balanceCents: 0, waitingEmails: 0 });
});

test('failed and approval-waiting agent turns return test credit before their notice email', async () => {
  for (const state of ['failed', 'needs_approval']) {
    const { env, sqlite } = pilot();
    credit(sqlite, 'account-1', 5, state);
    await deliver(env, `mail-${state}`);
    const token = device(sqlite);
    const claimed = await claim(env, token);
    assert.equal(claimed.claimed, true);
    const task = JSON.parse(Buffer.from(claimed.payload, 'base64url').toString());
    const completion = await handleDeviceRequest(new Request('https://relay.test/api/device/complete', {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jobId: task.jobId, leaseId: task.leaseId,
        result: { state, summary: 'The agent could not finish this task.' } }),
    }), env);
    assert.equal(completion.status, 200);
    assert.equal((await completion.json()).completed, true);
    assert.equal(sqlite.prepare('SELECT state FROM test_email_charges WHERE job_id = ?').get(task.jobId).state,
      'released');
    assert.deepEqual(await testWalletSnapshot(env, 'account-1'), { balanceCents: 5, waitingEmails: 0 });
    assert.equal((await sendNextOutbox(env, {
      sendEmail: async (payload) => {
        assert.match(payload.text, /This attempt did not use a TagMails test credit/);
        assert.match(payload.text, /TagMails test credits remaining: \$0\.05/);
        return { data: { id: `sent-${state}` } };
      },
      getSentEmail: async () => ({ data: { message_id: `<sent-${state}@tagmails.test>` } }),
    })).state, 'sent');
    await reconcileTestEmailCharges(env);
    assert.equal(sqlite.prepare('SELECT state FROM test_email_charges WHERE job_id = ?').get(task.jobId).state,
      'released');
  }
});

test('a primary-recipient bounce releases a test charge even before the send response', async () => {
  const { env, sqlite } = pilot();
  credit(sqlite, 'account-1', 5, 'owner');
  await deliver(env, 'bounced-1');
  const jobId = sqlite.prepare('SELECT id FROM jobs').get().id;
  await env.MAIL.put('results/bounced.json', JSON.stringify({ state: 'completed', summary: 'Done.' }));
  sqlite.prepare("UPDATE jobs SET state = 'completed', result_key = 'results/bounced.json' WHERE id = ?").run(jobId);
  sqlite.prepare('INSERT INTO outbox (job_id) VALUES (?)').run(jobId);
  const providerEmailId = '88888888-8888-4888-8888-888888888888';
  assert.equal((await sendNextOutbox(env, {
    sendEmail: async (payload) => {
      assert.deepEqual(await recordDeliveryOutcome(env, {
        jobId, providerEmailId, from: payload.from, subject: payload.subject,
        recipient: 'owner@gmail.com', status: 'bounced',
        eventAt: '2026-10-03T10:00:00.000Z', eventId: 'bounce-1',
      }), { accepted: true, deliveryOutcome: true });
      assert.equal(sqlite.prepare('SELECT state FROM test_email_charges WHERE job_id = ?').get(jobId).state, 'reserved');
      return { data: { id: providerEmailId } };
    },
    getSentEmail: async () => ({ data: { message_id: '<bounced@tagmails.test>' } }),
  })).state, 'sent');
  assert.equal(sqlite.prepare('SELECT state FROM test_email_charges WHERE job_id = ?').get(jobId).state, 'released');
  assert.deepEqual(await testWalletSnapshot(env, 'account-1'), { balanceCents: 5, waitingEmails: 0 });
  await reconcileTestEmailCharges(env);
  assert.equal(sqlite.prepare('SELECT state FROM test_email_charges WHERE job_id = ?').get(jobId).state, 'released');
});

test('scheduled reconciliation releases a settled charge after a missed bounce update', async () => {
  const { env, sqlite } = pilot();
  credit(sqlite, 'account-1', 5, 'owner');
  await deliver(env, 'bounced-2');
  const jobId = sqlite.prepare('SELECT id FROM jobs').get().id;
  await env.MAIL.put('results/bounced.json', JSON.stringify({ state: 'completed', summary: 'Done.' }));
  sqlite.prepare("UPDATE jobs SET state = 'completed', result_key = 'results/bounced.json' WHERE id = ?").run(jobId);
  sqlite.prepare('INSERT INTO outbox (job_id) VALUES (?)').run(jobId);
  const providerEmailId = '77777777-7777-4777-8777-777777777777';
  assert.equal((await sendNextOutbox(env, {
    sendEmail: async () => ({ data: { id: providerEmailId } }),
    getSentEmail: async () => ({ data: { message_id: '<bounced-2@tagmails.test>' } }),
  })).state, 'sent');
  sqlite.prepare(`INSERT INTO delivery_recipients
    (job_id, provider_email_id, recipient_email, status, event_at)
    VALUES (?, ?, 'owner@gmail.com', 'failed', '2026-10-03T10:00:00.000Z')`).run(jobId, providerEmailId);
  assert.equal(sqlite.prepare('SELECT state FROM test_email_charges WHERE job_id = ?').get(jobId).state, 'settled');
  await reconcileTestEmailCharges(env);
  assert.equal(sqlite.prepare('SELECT state FROM test_email_charges WHERE job_id = ?').get(jobId).state, 'released');
  assert.deepEqual(await testWalletSnapshot(env, 'account-1'), { balanceCents: 5, waitingEmails: 0 });
});

test('owner revocation releases a guest job that cannot be delivered', async () => {
  const { env, sqlite } = pilot();
  credit(sqlite, 'account-1', 10, 'owner');
  await deliver(env, 'owner-1', 'owner@gmail.com', { cc: ['guest@gmail.com'] });
  const parent = '<owner-1@gmail.com>';
  assert.deepEqual(await deliver(env, 'guest-1', 'guest@gmail.com', { parentIds: [parent] }),
    { accepted: true, duplicate: false, awaitingCredits: false });
  const token = 'B'.repeat(43);
  sqlite.prepare("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, 'account-1', datetime('now', '+1 day'))")
    .run(createHash('sha256').update(token).digest('hex'));
  const threadId = sqlite.prepare('SELECT id FROM threads').get().id;
  const response = await handleAccountRequest(new Request(`https://relay.test/api/account/threads/${threadId}/revoke`, {
    method: 'POST', headers: { Origin: 'https://relay.test', Cookie: `__Host-tm_session=${token}` },
    body: JSON.stringify({ email: 'guest@gmail.com' }),
  }), env);
  assert.equal(response.status, 200);
  const row = sqlite.prepare(`SELECT j.state job_state, c.state charge_state FROM jobs j
    JOIN messages m ON m.id = j.message_id JOIN test_email_charges c ON c.job_id = j.id
    WHERE m.sender_email = 'guest@gmail.com'`).get();
  assert.deepEqual({ ...row }, { job_state: 'failed', charge_state: 'released' });
  assert.deepEqual(await testWalletSnapshot(env, 'account-1'), { balanceCents: 5, waitingEmails: 0 });
});
