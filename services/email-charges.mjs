import { notifyDevices } from './device-push.mjs';

// Each email costs a quarter of a cent by default, kept in thousandths of a
// cent; a relay can set EMAIL_PRICE_MILLICENTS. Top-ups and the ledger stay in
// whole cents (1 cent = 1,000 millicents).
export const EMAIL_PRICE_MILLICENTS = 250;

export function emailPriceMillicents(env) {
  const price = Number(env.EMAIL_PRICE_MILLICENTS);
  return Number.isSafeInteger(price) && price > 0 ? price : EMAIL_PRICE_MILLICENTS;
}

// Cloudflare Email Sending caps a whole message at 5 MiB. Base64 adds a third,
// so 3.5 MB of files plus a 32k-character answer stays under it.
export const ATTACHABLE_BYTES = 3_500_000;

// Live billing needs both the explicit flag and a live Stripe key; test
// billing needs a test key. The two never mix.
export function billingLive(env) {
  return env.BILLING_LIVE === 'true' && /^(?:sk|rk)_live_/.test(env.STRIPE_SECRET_KEY ?? '') &&
    Boolean(env.STRIPE_WEBHOOK_SECRET?.startsWith('whsec_'));
}

export function testBillingEnabled(env) {
  if (billingLive(env)) return true;
  return env.BILLING_TEST_MODE === 'true' &&
    /^(?:sk|rk)_test_/.test(env.STRIPE_SECRET_KEY ?? '') &&
    env.STRIPE_WEBHOOK_SECRET?.startsWith('whsec_');
}

function changed(result) {
  return result.meta?.changes ?? result.changes ?? 0;
}

export async function reservePendingTestEmails(env, accountId, limit = 20) {
  if (!testBillingEnabled(env)) return 0;
  let reserved = 0;
  for (let index = 0; index < limit; index += 1) {
    // One INSERT computes the latest balance and reserves one oldest job. The
    // account cannot reserve the same credit twice when deliveries race.
    const result = await env.DB.prepare(`INSERT INTO test_email_charges
      (job_id, account_id, amount_millicents, state)
      SELECT j.id, t.account_id, ?, 'reserved'
      FROM jobs j JOIN threads t ON t.id = j.thread_id
      JOIN accounts a ON a.id = t.account_id
      JOIN messages m ON m.id = j.message_id
      WHERE t.account_id = ? AND a.active = 1 AND j.state = 'queued'
        AND json_extract(j.model_json, '$.error') IS NULL
        AND (m.sender_email = a.owner_email OR EXISTS
          (SELECT 1 FROM participants p WHERE p.thread_id = t.id
            AND p.email = m.sender_email AND p.revoked_at IS NULL))
        AND NOT EXISTS (SELECT 1 FROM test_email_charges c WHERE c.job_id = j.id)
        AND (SELECT COALESCE(SUM(amount_cents), 0) * 1000 FROM credit_ledger WHERE account_id = t.account_id)
          - (SELECT COALESCE(SUM(amount_millicents), 0) FROM test_email_charges
             WHERE account_id = t.account_id AND state != 'released') >= ?
      ORDER BY j.created_at, j.rowid LIMIT 1`)
      .bind(emailPriceMillicents(env), accountId, emailPriceMillicents(env)).run();
    if (!changed(result)) break;
    reserved += 1;
  }
  if (reserved) await notifyDevices(env, accountId);
  return reserved;
}

export async function fundPendingTestEmails(env) {
  if (!testBillingEnabled(env)) return;
  const rows = await env.DB.prepare(`SELECT DISTINCT t.account_id FROM jobs j
    JOIN threads t ON t.id = j.thread_id JOIN messages m ON m.id = j.message_id
    JOIN accounts a ON a.id = t.account_id
    WHERE j.state = 'queued' AND NOT EXISTS
      (SELECT 1 FROM test_email_charges c WHERE c.job_id = j.id)
      AND json_extract(j.model_json, '$.error') IS NULL
      AND (m.sender_email = a.owner_email OR EXISTS
        (SELECT 1 FROM participants p WHERE p.thread_id = t.id
          AND p.email = m.sender_email AND p.revoked_at IS NULL))
      -- Only accounts that can pay now; ten that can't must not starve one that can.
      AND a.active = 1 AND (SELECT COALESCE(SUM(amount_cents), 0) * 1000 FROM credit_ledger WHERE account_id = t.account_id)
        - (SELECT COALESCE(SUM(amount_millicents), 0) FROM test_email_charges
           WHERE account_id = t.account_id AND state != 'released') >= ?
    ORDER BY t.account_id LIMIT 10`).bind(emailPriceMillicents(env)).all();
  for (const row of rows.results ?? rows) await reservePendingTestEmails(env, row.account_id);
}

export async function testWalletSnapshot(env, accountId) {
  const row = await env.DB.prepare(`SELECT
    (SELECT COALESCE(SUM(amount_cents), 0) * 1000 FROM credit_ledger WHERE account_id = ?) AS credits,
    (SELECT COALESCE(SUM(amount_millicents), 0) FROM test_email_charges
      WHERE account_id = ? AND state != 'released') AS charges,
    (SELECT COUNT(*) FROM jobs j JOIN threads t ON t.id = j.thread_id
      JOIN messages m ON m.id = j.message_id JOIN accounts a ON a.id = t.account_id
      WHERE t.account_id = ? AND j.state = 'queued'
        AND NOT EXISTS (SELECT 1 FROM test_email_charges c WHERE c.job_id = j.id)
        AND json_extract(j.model_json, '$.error') IS NULL
        AND (m.sender_email = a.owner_email OR EXISTS
          (SELECT 1 FROM participants p WHERE p.thread_id = t.id
            AND p.email = m.sender_email AND p.revoked_at IS NULL))) AS waiting
  `).bind(accountId, accountId, accountId).first();
  // Shown as dollars and cents, rounded down so a balance never looks higher than it is.
  const balanceMillicents = row.credits - row.charges;
  return { balanceCents: Math.floor(balanceMillicents / 1000), waitingEmails: row.waiting };
}

// Unpaid relay replies an account may send per day. Without a cap, an account
// with no balance could mail 'Model: nonexistent' with a Cc again and again and
// have Tagmails send each Cc'd stranger a free reply.
export const FREE_RELAY_REPLIES_PER_DAY = 5;

// Whether Tagmails may write this account a reply of its own now: always when
// the balance covers it, otherwise within the daily free allowance.
export async function relayReplyAllowed(env, accountId) {
  if (!testBillingEnabled(env)) return true;
  const row = await env.DB.prepare(`SELECT
    (SELECT COALESCE(SUM(amount_cents), 0) * 1000 FROM credit_ledger WHERE account_id = ?)
      - (SELECT COALESCE(SUM(amount_millicents), 0) FROM test_email_charges
         WHERE account_id = ? AND state != 'released') AS balance,
    (SELECT COUNT(*) FROM jobs j JOIN threads t ON t.id = j.thread_id JOIN outbox o ON o.job_id = j.id
      WHERE t.account_id = ? AND j.created_at > datetime('now', '-1 day')
        AND j.lease_id IS NULL -- written by the relay; no computer ever claimed it
        AND NOT EXISTS (SELECT 1 FROM test_email_charges c WHERE c.job_id = j.id)) AS free`)
    .bind(accountId, accountId, accountId).first();
  return row.balance >= emailPriceMillicents(env) || row.free < FREE_RELAY_REPLIES_PER_DAY;
}

// Replies Tagmails writes itself (a question back, a revoked computer) are
// charged when the balance covers them, and still sent free when it doesn't
// (up to FREE_RELAY_REPLIES_PER_DAY).
export async function chargeRelayReply(env, jobId) {
  if (!testBillingEnabled(env)) return;
  await env.DB.prepare(`INSERT OR IGNORE INTO test_email_charges (job_id, account_id, amount_millicents, state)
    SELECT j.id, t.account_id, ?, 'reserved' FROM jobs j JOIN threads t ON t.id = j.thread_id
    WHERE j.id = ? AND (SELECT COALESCE(SUM(amount_cents), 0) * 1000 FROM credit_ledger WHERE account_id = t.account_id)
      - (SELECT COALESCE(SUM(amount_millicents), 0) FROM test_email_charges
         WHERE account_id = t.account_id AND state != 'released') >= ?`)
    .bind(emailPriceMillicents(env), jobId, emailPriceMillicents(env)).run();
}

export async function settleTestEmail(env, jobId) {
  if (!testBillingEnabled(env)) return;
  await env.DB.prepare(`UPDATE test_email_charges SET state = 'settled', updated_at = CURRENT_TIMESTAMP
    WHERE job_id = ? AND state = 'reserved'`).bind(jobId).run();
}

export async function releaseTestEmail(env, jobId) {
  if (!testBillingEnabled(env)) return;
  await env.DB.prepare(`UPDATE test_email_charges SET state = 'released', updated_at = CURRENT_TIMESTAMP
    WHERE job_id = ? AND state = 'reserved'`).bind(jobId).run();
}

export async function releaseFailedPrimaryTestEmail(env, jobId) {
  if (!testBillingEnabled(env)) return;
  const outbox = await env.DB.prepare(`SELECT o.provider_email_id, o.payload_json FROM outbox o
    JOIN test_email_charges c ON c.job_id = o.job_id
    WHERE o.job_id = ? AND o.provider_email_id IS NOT NULL
      AND c.state IN ('reserved', 'settled')`).bind(jobId).first();
  if (!outbox) return;
  let primary;
  try {
    const to = JSON.parse(outbox.payload_json).to;
    if (Array.isArray(to) && to.length === 1) primary = to[0];
  } catch { return; }
  if (!primary) return;
  const failure = await env.DB.prepare(`SELECT 1 FROM delivery_recipients
    WHERE job_id = ? AND provider_email_id = ? AND recipient_email = ?
      AND status IN ('bounced', 'failed', 'suppressed')`).bind(jobId, outbox.provider_email_id, primary).first();
  if (!failure) return;
  await env.DB.prepare(`UPDATE test_email_charges SET state = 'released', updated_at = CURRENT_TIMESTAMP
    WHERE job_id = ? AND state IN ('reserved', 'settled')`).bind(jobId).run();
}

export async function reconcileTestEmailCharges(env) {
  if (!testBillingEnabled(env)) return;
  const rows = await env.DB.prepare(`SELECT c.job_id, o.state FROM test_email_charges c
    JOIN outbox o ON o.job_id = c.job_id
    WHERE c.state = 'reserved' AND o.state IN ('blocked', 'accepted', 'sent')
    ORDER BY c.created_at, c.job_id LIMIT 50`).bind().all();
  for (const row of rows.results ?? rows) {
    if (row.state === 'blocked') await releaseTestEmail(env, row.job_id);
    else await settleTestEmail(env, row.job_id);
  }
  const failed = await env.DB.prepare(`SELECT c.job_id FROM test_email_charges c
    JOIN outbox o ON o.job_id = c.job_id
    JOIN delivery_recipients d ON d.job_id = o.job_id AND d.provider_email_id = o.provider_email_id
    WHERE c.state IN ('reserved', 'settled') AND o.provider_email_id IS NOT NULL
      AND d.status IN ('bounced', 'failed', 'suppressed')
      AND json_array_length(json_extract(o.payload_json, '$.to')) = 1
      AND d.recipient_email = json_extract(o.payload_json, '$.to[0]')
    ORDER BY c.updated_at, c.job_id LIMIT 50`).bind().all();
  for (const row of failed.results ?? failed) await releaseFailedPrimaryTestEmail(env, row.job_id);
}
