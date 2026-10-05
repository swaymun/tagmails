import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import { bindings } from './bindings-fixture.mjs';
import { handleTestWalletRequest, reconcileDueRefunds } from './billing-wallet.mjs';
import { testBillingEnabled } from './email-charges.mjs';

const origin = 'https://relay.test';
const token = 'A'.repeat(43);
const cookie = `__Host-tm_session=${token}`;

function fixture() {
  const { env, sqlite } = bindings();
  sqlite.prepare("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, 'account-1', datetime('now', '+1 day'))")
    .run(createHash('sha256').update(token).digest('hex'));
  env.BILLING_TEST_MODE = 'true';
  env.STRIPE_SECRET_KEY = 'sk_test_local';
  env.STRIPE_WEBHOOK_SECRET = 'whsec_local';
  env.PUBLIC_ORIGIN = origin;
  return { env, sqlite };
}

function request(path, method = 'GET', headers = {}, body) {
  return new Request(`${origin}${path}`, {
    method, headers: { Cookie: cookie, ...(method === 'POST' ? { Origin: origin } : {}), ...headers },
    ...(body === undefined ? {} : { body }),
  });
}

function signedEvent(event, secret = 'whsec_local') {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return request('/webhooks/stripe', 'POST', { 'Stripe-Signature': `t=${timestamp},v1=${signature}` }, body);
}

test('test billing accepts a restricted sandbox key but no live key', () => {
  assert.equal(Boolean(testBillingEnabled({ BILLING_TEST_MODE: 'true',
    STRIPE_SECRET_KEY: 'rk_test_tagmails', STRIPE_WEBHOOK_SECRET: 'whsec_local' })), true);
  assert.equal(Boolean(testBillingEnabled({ BILLING_TEST_MODE: 'true',
    STRIPE_SECRET_KEY: 'rk_live_tagmails', STRIPE_WEBHOOK_SECRET: 'whsec_local' })), false);
});

test('test Checkout credits once after a signed paid event and reverses a successful refund', async () => {
  const { env, sqlite } = fixture();
  let currentRefund;
  const call = async (req, extra = {}) => handleTestWalletRequest(req, env, {
    stripeFetch: extra.stripeFetch ?? (async () => Response.json(currentRefund)),
  });
  assert.equal((await call(request('/api/billing', 'GET', { Cookie: '' }))).status, 401);
  assert.equal((await call(request('/api/billing'))).status, 200);
  assert.equal((await (await call(request('/api/billing'))).json()).balanceCents, 0);
  assert.equal((await call(request('/api/billing/checkout', 'POST', { Origin: 'https://other.test' }))).status, 403);
  let checkoutId;
  const stripeFetch = async (url, options) => {
    assert.equal(url, 'https://api.stripe.com/v1/checkout/sessions');
    assert.equal(options.headers.Authorization, 'Bearer sk_test_local');
    const form = new URLSearchParams(options.body);
    checkoutId = form.get('client_reference_id');
    assert.equal(form.get('line_items[0][price_data][unit_amount]'), '1000');
    assert.equal(form.get('payment_method_types[0]'), 'card');
    assert.equal(form.get('customer_email'), 'owner@gmail.com');
    return Response.json({ id: 'cs_test_topup_1', url: 'https://checkout.stripe.com/c/pay/cs_test_topup_1' });
  };
  const checkout = await call(request('/api/billing/checkout', 'POST'), { stripeFetch });
  assert.equal(checkout.status, 200);
  assert.match((await checkout.json()).checkoutUrl, /^https:\/\/checkout\.stripe\.com\//);
  assert.equal((await (await call(request('/api/billing'))).json()).balanceCents, 0);

  const session = { object: 'checkout.session', id: 'cs_test_topup_1', client_reference_id: checkoutId,
    mode: 'payment', payment_status: 'paid', amount_total: 1000, currency: 'usd', payment_intent: 'pi_test_1' };
  const paid = { id: 'evt_paid_1', livemode: false, type: 'checkout.session.completed', data: { object: session } };
  const fake = signedEvent(paid, 'whsec_wrong');
  assert.equal((await call(fake)).status, 400);
  const unpaid = { ...paid, data: { object: { ...session, payment_status: 'unpaid' } } };
  assert.equal((await call(signedEvent(unpaid))).status, 200);
  assert.equal((await (await call(request('/api/billing'))).json()).balanceCents, 0);
  sqlite.prepare('UPDATE billing_checkouts SET stripe_payment_intent = ? WHERE id = ?').run('pi_test_1', checkoutId);
  const refund = { id: 're_test_1', object: 'refund', payment_intent: 'pi_test_1', status: 'succeeded', currency: 'usd', amount: 400 };
  currentRefund = refund;
  const event = { id: 'evt_refund_1', livemode: false, type: 'refund.updated', data: { object: refund } };
  assert.equal((await call(signedEvent(event))).status, 200);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM refund_notifications').get().n, 1);
  assert.equal((await call(signedEvent(paid))).status, 200);
  assert.equal((await call(signedEvent({ ...paid, id: 'evt_paid_replay' }))).status, 200);
  assert.equal((await (await call(request('/api/billing'))).json()).balanceCents, 600);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM credit_ledger WHERE kind = 'test_top_up'").get().n, 1);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM credit_ledger WHERE kind = 'test_refund'").get().n, 1);
  sqlite.prepare('INSERT INTO accounts (id, google_sub, owner_email, agent_email) VALUES (?, ?, ?, ?)')
    .run('account-2', 'google-sub-2', 'other@gmail.com', 'other@wonder.test');
  const otherToken = 'B'.repeat(43);
  sqlite.prepare("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, 'account-2', datetime('now', '+1 day'))")
    .run(createHash('sha256').update(otherToken).digest('hex'));
  const otherBalance = await call(request('/api/billing', 'GET', { Cookie: `__Host-tm_session=${otherToken}` }));
  assert.equal((await otherBalance.json()).balanceCents, 0);

  assert.equal((await call(signedEvent(event))).status, 200);
  assert.equal((await call(signedEvent({ ...event, id: 'evt_refund_replay' }))).status, 200);
  assert.equal((await (await call(request('/api/billing'))).json()).balanceCents, 600);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM credit_ledger WHERE kind = 'test_refund'").get().n, 1);
  currentRefund = { ...refund, status: 'failed' };
  assert.equal((await call(signedEvent({ ...event, id: 'evt_refund_failed', type: 'refund.failed' }))).status, 200);
  assert.equal((await call(signedEvent({ ...event, id: 'evt_stale_refund' }))).status, 200);
  assert.equal((await (await call(request('/api/billing'))).json()).balanceCents, 1000);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM credit_ledger WHERE kind = 'test_refund_restored'").get().n, 1);
});

test('the private Site shows only its Gmail owner test credits and returns from test Checkout', async () => {
  const { env, sqlite } = fixture();
  env.SITE_ORIGIN = 'https://tagmails.chatgpt.site';
  env.SITE_ALLOWED_ORIGINS = 'https://tagmails.com,https://www.tagmails.com';
  env.GOOGLE_CLIENT_ID = 'test-google-client';
  const site = (path, method = 'GET', bearer = 'owner-token', siteOrigin = env.SITE_ORIGIN) =>
    new Request(`${origin}${path}`, { method, headers: {
      Origin: siteOrigin, Authorization: `Bearer ${bearer}`,
    } });
  let checkout;
  let checkoutCalls = 0;
  const call = (req) => handleTestWalletRequest(req, env, {
    verifyIdentity: async (credential) => {
      if (credential !== 'owner-token') throw new Error('Invalid token');
      return { sub: 'google-sub-1', email: 'owner@gmail.com' };
    },
    stripeFetch: async (url, options) => {
      assert.equal(url, 'https://api.stripe.com/v1/checkout/sessions');
      checkout = new URLSearchParams(options.body);
      const id = `cs_test_site_${++checkoutCalls}`;
      return Response.json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
    },
  });
  assert.equal((await call(site('/api/site/billing', 'OPTIONS'))).status, 204);
  assert.equal((await call(site('/api/site/billing', 'GET', 'bad-token'))).status, 401);
  assert.equal((await call(site('/api/site/billing', 'GET', 'owner-token', 'https://other.test'))).status, 403);
  assert.equal((await call(site('/api/site/billing', 'GET', 'owner-token', 'https://other.test')))
    .headers.get('access-control-allow-origin'), null);
  const balance = await call(site('/api/site/billing'));
  assert.equal(balance.headers.get('access-control-allow-origin'), env.SITE_ORIGIN);
  assert.deepEqual(await balance.json(), { balanceCents: 0, waitingEmails: 0,
    currency: 'usd', testMode: true, checkoutEnabled: true });
  assert.equal((await call(site('/api/site/billing', 'GET', 'owner-token', 'http://tagmails.chatgpt.site'))).status, 403);
  assert.equal((await handleTestWalletRequest(site('/api/site/billing'), env, {
    verifyIdentity: async () => ({ sub: 'other-sub', email: 'other@gmail.com' }),
  })).status, 404);
  const response = await call(site('/api/site/billing/checkout', 'POST'));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).testMode, true);
  assert.equal(checkout.get('success_url'), `${env.SITE_ORIGIN}/?topup=returned#billing`);
  assert.equal(checkout.get('cancel_url'), `${env.SITE_ORIGIN}/?topup=canceled#billing`);
  assert.equal(checkout.get('customer_email'), 'owner@gmail.com');
  assert.equal(sqlite.prepare('SELECT count(*) n FROM billing_checkouts').get().n, 1);
  assert.equal((await call(site('/api/site/billing/checkout', 'POST', 'owner-token',
    'https://tagmails.com'))).status, 200);
  assert.equal(checkout.get('success_url'), 'https://tagmails.com/?topup=returned#billing');
  assert.equal(checkout.get('cancel_url'), 'https://tagmails.com/?topup=canceled#billing');
  assert.equal(sqlite.prepare('SELECT count(*) n FROM billing_checkouts').get().n, 2);
  env.BILLING_TEST_MODE = 'false';
  assert.equal((await (await call(site('/api/site/billing'))).json()).checkoutEnabled, false);
  assert.equal((await call(site('/api/site/billing/checkout', 'POST'))).status, 503);
});

test('wallet rejects live keys, live events, mismatched paid sessions, and unknown refunds', async () => {
  const { env, sqlite } = fixture();
  const call = async (req) => handleTestWalletRequest(req, env, {
    stripeFetch: async () => Response.json({ object: 'refund', id: 're_unknown', payment_intent: 'pi_unknown',
      status: 'succeeded', amount: 100, currency: 'usd' }),
  });
  env.STRIPE_SECRET_KEY = 'sk_live_not_allowed';
  assert.equal((await call(request('/api/billing/checkout', 'POST'))).status, 503);
  env.STRIPE_SECRET_KEY = 'sk_test_local';
  const live = { id: 'evt_live', livemode: true, type: 'checkout.session.completed', data: { object: {} } };
  assert.equal((await call(signedEvent(live))).status, 400);
  const mismatch = { id: 'evt_wrong', livemode: false, type: 'checkout.session.completed', data: { object: {
    object: 'checkout.session', id: 'cs_test_wrong', client_reference_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    mode: 'payment', payment_status: 'paid', amount_total: 1000, currency: 'usd', payment_intent: 'pi_wrong',
  } } };
  assert.equal((await call(signedEvent(mismatch))).status, 409);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM credit_ledger').get().n, 0);
  const refund = { id: 'evt_refund_unknown', livemode: false, type: 'refund.created', data: { object: {
    object: 'refund', id: 're_unknown', payment_intent: 'pi_unknown', status: 'succeeded', amount: 100, currency: 'usd',
  } } };
  assert.equal((await call(signedEvent(refund))).status, 200);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM refund_notifications').get().n, 1);
});

test('failed ledger insertion rolls back the paid checkout association', async () => {
  const { env, sqlite } = fixture();
  const checkoutId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  sqlite.prepare('INSERT INTO billing_checkouts (id, account_id, amount_cents) VALUES (?, ?, ?)')
    .run(checkoutId, 'account-1', 1000);
  const paid = { id: 'evt_atomic', livemode: false, type: 'checkout.session.completed', data: { object: {
    object: 'checkout.session', id: 'cs_test_atomic', client_reference_id: checkoutId,
    mode: 'payment', payment_status: 'paid', amount_total: 1000, currency: 'usd', payment_intent: 'pi_atomic',
  } } };
  sqlite.exec("CREATE TRIGGER fail_credit BEFORE INSERT ON credit_ledger BEGIN SELECT RAISE(ABORT, 'simulated ledger failure'); END");
  await assert.rejects(handleTestWalletRequest(signedEvent(paid), env), /simulated ledger failure/);
  assert.equal(sqlite.prepare('SELECT stripe_payment_intent FROM billing_checkouts WHERE id = ?').get(checkoutId).stripe_payment_intent, null);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM credit_ledger').get().n, 0);
  sqlite.exec('DROP TRIGGER fail_credit');
  assert.equal((await handleTestWalletRequest(signedEvent(paid), env)).status, 200);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM credit_ledger').get().n, 1);
});

test('scheduled reconciliation applies a refund after its first provider lookup fails', async () => {
  const { env, sqlite } = fixture();
  const checkoutId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  sqlite.prepare(`INSERT INTO billing_checkouts
    (id, account_id, amount_cents, stripe_session_id, stripe_payment_intent) VALUES (?, ?, ?, ?, ?)`)
    .run(checkoutId, 'account-1', 1000, 'cs_test_retry', 'pi_retry');
  sqlite.prepare(`INSERT INTO credit_ledger (id, account_id, checkout_id, amount_cents, kind, source_id)
    VALUES (?, ?, ?, ?, 'test_top_up', ?)`).run('credit-retry', 'account-1', checkoutId, 1000, 'cs_test_retry');
  const refund = { object: 'refund', id: 're_retry', payment_intent: 'pi_retry',
    status: 'succeeded', currency: 'usd', amount: 300 };
  const event = { id: 'evt_refund_retry', livemode: false, type: 'refund.updated', data: { object: refund } };
  const failed = await handleTestWalletRequest(signedEvent(event), env, {
    stripeFetch: async () => new Response('Unavailable', { status: 502 }),
  });
  assert.equal(failed.status, 502);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM refund_notifications').get().n, 1);
  sqlite.prepare("UPDATE refund_notifications SET next_check_at = datetime('now', '-1 minute')").run();
  await reconcileDueRefunds(env, { stripeFetch: async () => Response.json(refund) });
  await reconcileDueRefunds(env, { stripeFetch: async () => { throw new Error('Already resolved'); } });
  assert.equal(sqlite.prepare('SELECT SUM(amount_cents) balance FROM credit_ledger').get().balance, 700);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM refund_notifications WHERE resolved_at IS NOT NULL').get().n, 1);
});

test('live billing needs the flag and a live key, accepts only live events, and grants bonuses and transfer charges once', async () => {
  const { billingLive, testBillingEnabled, grantSignupBonus, chargeFileTransfer } = await import('./email-charges.mjs');
  assert.equal(billingLive({ BILLING_LIVE: 'true', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' }), false);
  assert.equal(billingLive({ STRIPE_SECRET_KEY: 'rk_live_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' }), false);
  const live = { BILLING_LIVE: 'true', STRIPE_SECRET_KEY: 'rk_live_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' };
  assert.equal(billingLive(live), true);
  assert.equal(testBillingEnabled(live), true);
  const { env, sqlite } = bindings();
  Object.assign(env, live);
  await grantSignupBonus(env, 'account-1');
  await grantSignupBonus(env, 'account-1');
  await chargeFileTransfer(env, 'account-1', 'artifact-small', 3_000_000);
  await chargeFileTransfer(env, 'account-1', 'artifact-big', 1_200_000_000);
  await chargeFileTransfer(env, 'account-1', 'artifact-big', 1_200_000_000);
  const rows = sqlite.prepare('SELECT kind, amount_cents FROM credit_ledger ORDER BY kind').all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [{ kind: 'file_transfer', amount_cents: -10 }, { kind: 'signup_bonus', amount_cents: 100 }]);
});

test('live Checkout accepts only live sessions and credits a signed live payment', async () => {
  const { env, sqlite } = fixture();
  Object.assign(env, { BILLING_LIVE: 'true', STRIPE_SECRET_KEY: 'rk_live_local' });
  let checkoutId;
  let sessionId = 'cs_test_wrong_mode';
  const stripeFetch = async (url, options) => {
    checkoutId = new URLSearchParams(options.body).get('client_reference_id');
    return Response.json({ id: sessionId, url: `https://checkout.stripe.com/c/pay/${sessionId}` });
  };
  const call = (req) => handleTestWalletRequest(req, env, { stripeFetch });
  assert.equal((await call(request('/api/billing/checkout', 'POST'))).status, 502);
  sessionId = 'cs_live_topup_1';
  const checkout = await call(request('/api/billing/checkout', 'POST'));
  assert.equal(checkout.status, 200);
  assert.equal((await checkout.json()).testMode, false);
  const session = { object: 'checkout.session', id: sessionId, client_reference_id: checkoutId,
    mode: 'payment', payment_status: 'paid', amount_total: 1000, currency: 'usd', payment_intent: 'pi_live_1' };
  assert.equal((await call(signedEvent({ id: 'evt_test_mode', livemode: false,
    type: 'checkout.session.completed', data: { object: session } }))).status, 400);
  assert.equal((await call(signedEvent({ id: 'evt_live_1', livemode: true,
    type: 'checkout.session.completed', data: { object: session } }))).status, 200);
  assert.equal(sqlite.prepare("SELECT SUM(amount_cents) n FROM credit_ledger WHERE kind = 'test_top_up'").get().n, 1000);
});
