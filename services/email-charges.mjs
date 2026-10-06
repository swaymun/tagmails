export const TEST_EMAIL_CENTS = 5;

export const FILE_TRANSFER_CENTS_PER_GB = 5;
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

// Files too big to attach become download links: $0.05 per started GB.
export async function chargeFileTransfer(env, accountId, artifactId, bytes) {
  if (!testBillingEnabled(env) || bytes <= ATTACHABLE_BYTES) return;
  const cents = Math.ceil(bytes / 1e9) * FILE_TRANSFER_CENTS_PER_GB;
  await env.DB.prepare(`INSERT OR IGNORE INTO credit_ledger (id, account_id, amount_cents, kind, source_id)
    VALUES (?, ?, ?, 'file_transfer', ?)`).bind(crypto.randomUUID(), accountId, -cents, artifactId).run();
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
      (job_id, account_id, amount_cents, state)
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
        AND (SELECT COALESCE(SUM(amount_cents), 0) FROM credit_ledger WHERE account_id = t.account_id)
          - (SELECT COALESCE(SUM(amount_cents), 0) FROM test_email_charges
             WHERE account_id = t.account_id AND state != 'released') >= ?
      ORDER BY j.created_at, j.rowid LIMIT 1`)
      .bind(TEST_EMAIL_CENTS, accountId, TEST_EMAIL_CENTS).run();
    if (!changed(result)) break;
    reserved += 1;
  }
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
    ORDER BY t.account_id LIMIT 10`).bind().all();
  for (const row of rows.results ?? rows) await reservePendingTestEmails(env, row.account_id);
}

export async function testWalletSnapshot(env, accountId) {
  const row = await env.DB.prepare(`SELECT
    (SELECT COALESCE(SUM(amount_cents), 0) FROM credit_ledger WHERE account_id = ?) AS credits,
    (SELECT COALESCE(SUM(amount_cents), 0) FROM test_email_charges
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
  return { balanceCents: row.credits - row.charges, waitingEmails: row.waiting };
}

// Replies TagMails writes itself (a question back, a revoked computer) are
// charged when the balance covers them, and still sent free when it doesn't.
export async function chargeRelayReply(env, jobId) {
  if (!testBillingEnabled(env)) return;
  await env.DB.prepare(`INSERT OR IGNORE INTO test_email_charges (job_id, account_id, amount_cents, state)
    SELECT j.id, t.account_id, ?, 'reserved' FROM jobs j JOIN threads t ON t.id = j.thread_id
    WHERE j.id = ? AND (SELECT COALESCE(SUM(amount_cents), 0) FROM credit_ledger WHERE account_id = t.account_id)
      - (SELECT COALESCE(SUM(amount_cents), 0) FROM test_email_charges
         WHERE account_id = t.account_id AND state != 'released') >= ?`)
    .bind(TEST_EMAIL_CENTS, jobId, TEST_EMAIL_CENTS).run();
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
