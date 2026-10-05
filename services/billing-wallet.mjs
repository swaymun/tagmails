import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { accountFor, sameOrigin, siteCors, siteOriginFor, siteOwnerFor, verifyGoogleCredential } from './account-auth.mjs';
import { billingLive, reservePendingTestEmails, testBillingEnabled, testWalletSnapshot } from './email-charges.mjs';

const TOP_UP_CENTS = 1000;
const MAX_WEBHOOK_BYTES = 128_000;
const UUID = /^[0-9a-f-]{36}$/i;

function json(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

function originFor(request, env) {
  try {
    const configured = new URL(env.PUBLIC_ORIGIN);
    const local = ['localhost', '127.0.0.1'].includes(configured.hostname);
    if ((configured.protocol !== 'https:' && !(local && configured.protocol === 'http:' && configured.port)) ||
        configured.pathname !== '/' || configured.search || configured.hash ||
        configured.username || configured.password || configured.origin !== new URL(request.url).origin) return null;
    return configured.origin;
  } catch { return null; }
}

async function boundedBody(request) {
  if (Number(request.headers.get('content-length') || 0) > MAX_WEBHOOK_BYTES) throw new Error('Webhook too large');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing webhook body');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_WEBHOOK_BYTES) { await reader.cancel(); throw new Error('Webhook too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function verifyStripeSignature(body, signature, secret, now = Date.now()) {
  const parts = Object.fromEntries((signature ?? '').split(',').map((part) => part.split('=', 2)));
  const timestamp = Number(parts.t);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now / 1000 - timestamp) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest();
  return (signature ?? '').split(',').filter((part) => part.startsWith('v1='))
    .some((part) => {
      const value = part.slice(3);
      if (!/^[0-9a-f]{64}$/i.test(value)) return false;
      return timingSafeEqual(expected, Buffer.from(value, 'hex'));
    });
}

async function createCheckout(request, env, account, stripeFetch, site = false) {
  const headers = site ? siteCors(request, env) : {};
  if (site ? !siteOriginFor(request, env) : !sameOrigin(request)) return json({ error: 'Invalid origin' }, 403, headers);
  const origin = site ? siteOriginFor(request, env) : originFor(request, env);
  if (!origin || !testBillingEnabled(env)) return json({ error: 'Test checkout is not configured' }, 503, headers);
  const id = randomUUID();
  await env.DB.prepare('INSERT INTO billing_checkouts (id, account_id, amount_cents) VALUES (?, ?, ?)')
    .bind(id, account.id, TOP_UP_CENTS).run();
  const form = new URLSearchParams({
    mode: 'payment',
    client_reference_id: id,
    customer_email: account.owner_email,
    success_url: `${origin}/${site ? '?topup=returned#billing' : 'account?topup=returned'}`,
    cancel_url: `${origin}/${site ? '?topup=canceled#billing' : 'account?topup=canceled'}`,
    'payment_method_types[0]': 'card',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(TOP_UP_CENTS),
    'line_items[0][price_data][product_data][name]': billingLive(env) ? 'TagMails balance ($10)' : 'TagMails test balance ($10)',
    'line_items[0][quantity]': '1',
  });
  const response = await stripeFetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': `tagmails-test-topup-${id}`,
    },
    body: form.toString(),
  });
  if (!response.ok) return json({ error: 'Stripe test checkout could not be created' }, 502, headers);
  const session = await response.json();
  let url;
  try { url = new URL(session.url); } catch { /* Invalid Stripe response. */ }
  if (!session.id?.startsWith(sessionPrefix(env)) || url?.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com') {
    return json({ error: 'Stripe returned an invalid checkout' }, 502, headers);
  }
  await env.DB.prepare('UPDATE billing_checkouts SET stripe_session_id = ? WHERE id = ? AND stripe_session_id IS NULL')
    .bind(session.id, id).run();
  return json({ checkoutUrl: url.href, testMode: !billingLive(env) }, 200, headers);
}

// Live and test Checkout Sessions never cross: the mode follows the key.
const sessionPrefix = (env) => billingLive(env) ? 'cs_live_' : 'cs_test_';

async function paidCheckout(env, session, stripeFetch) {
  if (session?.object !== 'checkout.session' || !session.id?.startsWith(sessionPrefix(env)) ||
      !UUID.test(session.client_reference_id ?? '') || session.mode !== 'payment' ||
      session.payment_status !== 'paid' || session.amount_total !== TOP_UP_CENTS ||
      session.currency !== 'usd' || !session.payment_intent?.startsWith('pi_')) {
    return json({ error: 'Paid session does not match a top-up' }, 422);
  }
  const row = await env.DB.prepare('SELECT id, account_id, amount_cents, stripe_session_id, stripe_payment_intent FROM billing_checkouts WHERE id = ?')
    .bind(session.client_reference_id).first();
  if (!row) return json({ error: 'Unknown checkout; retry later' }, 409);
  if (row.amount_cents !== TOP_UP_CENTS || (row.stripe_session_id && row.stripe_session_id !== session.id) ||
      (row.stripe_payment_intent && row.stripe_payment_intent !== session.payment_intent)) {
    return json({ error: 'Checkout identity mismatch' }, 409);
  }
  const [updated] = await env.DB.batch([
    env.DB.prepare(`UPDATE billing_checkouts
    SET stripe_session_id = ?, stripe_payment_intent = ?
    WHERE id = ? AND (stripe_session_id IS NULL OR stripe_session_id = ?)
      AND (stripe_payment_intent IS NULL OR stripe_payment_intent = ?)
    `).bind(session.id, session.payment_intent, row.id, session.id, session.payment_intent),
    env.DB.prepare(`INSERT INTO credit_ledger (id, account_id, checkout_id, amount_cents, kind, source_id)
      SELECT ?, account_id, id, ?, 'test_top_up', ? FROM billing_checkouts
      WHERE id = ? AND stripe_session_id = ? AND stripe_payment_intent = ?
      ON CONFLICT(kind, source_id) DO NOTHING`)
      .bind(randomUUID(), TOP_UP_CENTS, session.id, row.id, session.id, session.payment_intent),
  ]);
  if (!(updated.meta?.changes ?? updated.changes)) return json({ error: 'Checkout identity mismatch' }, 409);
  await reconcileRefundsForPayment(env, session.payment_intent, stripeFetch);
  await reservePendingTestEmails(env, row.account_id);
  return json({ received: true });
}

async function refundedCheckout(env, refund) {
  if (refund?.object !== 'refund' || !/^re_[A-Za-z0-9_]+$/.test(refund.id ?? '') ||
      !/^pi_[A-Za-z0-9_]+$/.test(refund.payment_intent ?? '') ||
      refund.currency !== 'usd' || !Number.isInteger(refund.amount) ||
      refund.amount <= 0 || refund.amount > TOP_UP_CENTS) {
    return json({ error: 'Refund does not match a test top-up' }, 422);
  }
  const row = await env.DB.prepare('SELECT id, account_id FROM billing_checkouts WHERE stripe_payment_intent = ?')
    .bind(refund.payment_intent).first();
  if (!row) return json({ error: 'Unknown payment; retry later' }, 409);
  const credited = await env.DB.prepare("SELECT id FROM credit_ledger WHERE checkout_id = ? AND kind = 'test_top_up'")
    .bind(row.id).first();
  if (!credited) return json({ error: 'Top-up has not been credited; retry later' }, 409);
  if (refund.status === 'succeeded') {
    await env.DB.prepare(`INSERT INTO credit_ledger (id, account_id, checkout_id, amount_cents, kind, source_id)
      VALUES (?, ?, ?, ?, 'test_refund', ?) ON CONFLICT(kind, source_id) DO NOTHING`)
      .bind(randomUUID(), row.account_id, row.id, -refund.amount, refund.id).run();
  } else if (['failed', 'canceled'].includes(refund.status)) {
    await env.DB.prepare(`INSERT INTO credit_ledger (id, account_id, checkout_id, amount_cents, kind, source_id)
      SELECT ?, account_id, checkout_id, -amount_cents, 'test_refund_restored', source_id
      FROM credit_ledger WHERE kind = 'test_refund' AND source_id = ? AND checkout_id = ?
      ON CONFLICT(kind, source_id) DO NOTHING`).bind(randomUUID(), refund.id, row.id).run();
  }
  return json({ received: true });
}

async function reconcileRefund(env, refundId, stripeFetch) {
  const notification = await env.DB.prepare('SELECT payment_intent FROM refund_notifications WHERE refund_id = ?')
    .bind(refundId).first();
  if (!notification) return json({ error: 'Refund notification is missing' }, 409);
  const response = await stripeFetch(`https://api.stripe.com/v1/refunds/${refundId}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!response.ok) return json({ error: 'Refund status could not be checked' }, 502);
  const refund = await response.json();
  if (refund.id !== refundId || refund.payment_intent !== notification.payment_intent) {
    return json({ error: 'Refund identity mismatch' }, 422);
  }
  const applied = await refundedCheckout(env, refund);
  await env.DB.prepare(`UPDATE refund_notifications
    SET resolved_at = ?, next_check_at = datetime('now', '+5 minutes') WHERE refund_id = ?`)
    .bind(applied.ok && ['succeeded', 'failed', 'canceled'].includes(refund.status) ? new Date().toISOString() : null, refundId).run();
  return applied.status === 409 ? json({ received: true, pending: true }) : applied;
}

async function reconcileRefundsForPayment(env, paymentIntent, stripeFetch = fetch) {
  const rows = await env.DB.prepare(`SELECT refund_id FROM refund_notifications
    WHERE payment_intent = ? AND resolved_at IS NULL ORDER BY created_at LIMIT 20`)
    .bind(paymentIntent).all();
  for (const row of rows.results ?? rows) {
    const result = await reconcileRefund(env, row.refund_id, stripeFetch);
    if (!result.ok) throw new Error('Known refund could not be reconciled');
  }
}

export async function reconcileDueRefunds(env, { stripeFetch = fetch } = {}) {
  if (!testBillingEnabled(env) || !env.DB) return;
  const rows = await env.DB.prepare(`SELECT refund_id FROM refund_notifications
    WHERE resolved_at IS NULL AND next_check_at <= CURRENT_TIMESTAMP ORDER BY next_check_at LIMIT 10`).bind().all();
  for (const row of rows.results ?? rows) {
    const result = await reconcileRefund(env, row.refund_id, stripeFetch);
    if (!result.ok) throw new Error('Pending refund could not be reconciled');
  }
}

async function stripeWebhook(request, env, now, stripeFetch) {
  if (!testBillingEnabled(env)) return json({ error: 'Test checkout is not configured' }, 503);
  let raw;
  try { raw = await boundedBody(request); }
  catch { return json({ error: 'Invalid webhook body' }, 413); }
  if (!verifyStripeSignature(raw, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET, now)) {
    return json({ error: 'Invalid Stripe signature' }, 400);
  }
  let event;
  try { event = JSON.parse(raw); } catch { return json({ error: 'Invalid Stripe event' }, 400); }
  if (!event.id?.startsWith('evt_') || event.livemode !== billingLive(env)) {
    return json({ error: billingLive(env) ? 'A Stripe live event is required' : 'A Stripe test event is required' }, 400);
  }
  if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
    if (event.data?.object?.payment_status !== 'paid') return json({ received: true, pending: true });
    return paidCheckout(env, event.data.object, stripeFetch);
  }
  if (['refund.created', 'refund.updated', 'refund.failed'].includes(event.type)) {
    const { id, payment_intent: paymentIntent } = event.data?.object ?? {};
    if (!/^re_[A-Za-z0-9_]+$/.test(id ?? '') || !/^pi_[A-Za-z0-9_]+$/.test(paymentIntent ?? '')) {
      return json({ error: 'Invalid refund identity' }, 422);
    }
    await env.DB.prepare(`INSERT INTO refund_notifications (refund_id, payment_intent)
      VALUES (?, ?) ON CONFLICT(refund_id) DO UPDATE SET
      next_check_at = CURRENT_TIMESTAMP, resolved_at = NULL
      WHERE payment_intent = excluded.payment_intent`).bind(id, paymentIntent).run();
    return reconcileRefund(env, id, stripeFetch);
  }
  return json({ received: true, ignored: true });
}

export async function handleTestWalletRequest(request, env, { stripeFetch = fetch, now = Date.now(),
  verifyIdentity = verifyGoogleCredential } = {}) {
  const pathname = new URL(request.url).pathname;
  const site = pathname === '/api/site/billing' || pathname === '/api/site/billing/checkout';
  if (!site && !['/api/billing', '/api/billing/checkout', '/webhooks/stripe'].includes(pathname)) return null;
  if (!env.DB) throw new Error('Account database is not configured');
  if (site) {
    const headers = siteCors(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: siteOriginFor(request, env) ? 204 : 403, headers });
    if (!siteOriginFor(request, env)) return json({ error: 'Invalid origin' }, 403);
    const owner = await siteOwnerFor(request, env, verifyIdentity);
    if (owner.error) return json({ error: owner.error }, owner.status, headers);
    if (pathname === '/api/site/billing' && request.method === 'GET') {
      const snapshot = await testWalletSnapshot(env, owner.account.id);
      return json({ ...snapshot, waitingEmails: testBillingEnabled(env) ? snapshot.waitingEmails : 0,
        currency: 'usd', testMode: !billingLive(env), checkoutEnabled: Boolean(testBillingEnabled(env)) }, 200, headers);
    }
    if (pathname === '/api/site/billing/checkout' && request.method === 'POST') {
      return createCheckout(request, env, owner.account, stripeFetch, true);
    }
    return json({ error: 'Not found' }, 404, headers);
  }
  if (pathname === '/webhooks/stripe') {
    return request.method === 'POST' ? stripeWebhook(request, env, now, stripeFetch) : new Response('Not found', { status: 404 });
  }
  const account = await accountFor(request, env);
  if (!account) return json({ error: 'Sign in required' }, 401);
  if (pathname === '/api/billing' && request.method === 'GET') {
    const snapshot = await testWalletSnapshot(env, account.id);
    return json({ ...snapshot, waitingEmails: testBillingEnabled(env) ? snapshot.waitingEmails : 0,
      currency: 'usd', testMode: !billingLive(env), checkoutEnabled: Boolean(testBillingEnabled(env) && originFor(request, env)) });
  }
  if (pathname === '/api/billing/checkout' && request.method === 'POST') return createCheckout(request, env, account, stripeFetch);
  return new Response('Not found', { status: 404 });
}
