import { buildStatusReaction } from './status-reaction-mime.mjs';
import { sendRawResendEmail } from './resend-smtp.mjs';
import { testSenderFor } from './agent-username.mjs';

const rank = (alias) => `CASE ${alias}.status WHEN 'received' THEN 0 WHEN 'working' THEN 1 ELSE 2 END`;

export async function sendNextStatusReaction(env, { send = sendRawResendEmail } = {}) {
  if (env.STATUS_REACTIONS_ENABLED !== 'true') return { state: 'disabled' };
  if (!env.DB || !env.RESEND_API_KEY) throw new Error('Status reaction bindings are incomplete');
  const stale = await env.DB.prepare(`UPDATE status_reactions SET state = 'uncertain', updated_at = CURRENT_TIMESTAMP
    WHERE (job_id, status) = (SELECT job_id, status FROM status_reactions
      WHERE state = 'sending' AND updated_at <= datetime('now', '-20 minutes')
      ORDER BY updated_at LIMIT 1) AND state = 'sending' RETURNING job_id, status`).bind().first();
  if (stale) return { state: 'uncertain', jobId: stale.job_id, status: stale.status };
  const row = await env.DB.prepare(`SELECT s.job_id, s.status, m.message_id, m.sender_email,
      t.id AS thread_id, t.subject, a.owner_email, a.agent_email
    FROM status_reactions s JOIN jobs j ON j.id = s.job_id
    JOIN messages m ON m.id = j.message_id JOIN threads t ON t.id = j.thread_id
    JOIN accounts a ON a.id = t.account_id
    WHERE s.state = 'queued' AND a.active = 1
      AND NOT EXISTS (SELECT 1 FROM status_reactions earlier WHERE earlier.job_id = s.job_id
        AND ${rank('earlier')} < ${rank('s')}
        AND earlier.state != 'accepted')
    ORDER BY s.updated_at, s.job_id, ${rank('s')} LIMIT 1`).bind().first();
  if (!row) return { state: 'idle' };
  const sender = row.sender_email.toLowerCase();
  const participant = sender === row.owner_email.toLowerCase() ? true : await env.DB.prepare(
    'SELECT 1 FROM participants WHERE thread_id = ? AND email = ? AND revoked_at IS NULL')
    .bind(row.thread_id, sender).first();
  // A reaction must come from the agent's own address, so test-sender accounts can't react.
  if (!participant || !sender.endsWith('@gmail.com') || testSenderFor(env, row.agent_email)) {
    await env.DB.prepare("UPDATE status_reactions SET state = 'blocked', updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND status = ? AND state = 'queued'")
      .bind(row.job_id, row.status).run();
    return { state: 'blocked', jobId: row.job_id, status: row.status };
  }
  const claimed = await env.DB.prepare("UPDATE status_reactions SET state = 'sending', updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND status = ? AND state = 'queued' RETURNING job_id")
    .bind(row.job_id, row.status).first();
  if (!claimed) return { state: 'contended' };
  const authorized = await env.DB.prepare(`SELECT 1 FROM accounts a
    WHERE a.agent_email = ? AND a.active = 1 AND
      (a.owner_email = ? OR EXISTS (SELECT 1 FROM participants p
        WHERE p.thread_id = ? AND p.email = ? AND p.revoked_at IS NULL)) LIMIT 1`)
    .bind(row.agent_email, sender, row.thread_id, sender).first();
  if (!authorized) {
    await env.DB.prepare("UPDATE status_reactions SET state = 'blocked', updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND status = ? AND state = 'sending'")
      .bind(row.job_id, row.status).run();
    return { state: 'blocked', jobId: row.job_id, status: row.status };
  }
  try {
    const message = buildStatusReaction({ jobId: row.job_id, status: row.status,
      from: row.agent_email.toLowerCase(), to: sender, targetMessageId: row.message_id,
      subject: row.subject });
    const sent = await send({ ...message, apiKey: env.RESEND_API_KEY });
    if (!sent?.accepted) throw new Error('SMTP did not confirm acceptance');
  } catch {
    await env.DB.prepare("UPDATE status_reactions SET state = 'uncertain', updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND status = ? AND state = 'sending'")
      .bind(row.job_id, row.status).run();
    return { state: 'uncertain', jobId: row.job_id, status: row.status };
  }
  await env.DB.prepare("UPDATE status_reactions SET state = 'accepted', updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND status = ? AND state = 'sending'")
    .bind(row.job_id, row.status).run();
  return { state: 'accepted', jobId: row.job_id, status: row.status };
}
