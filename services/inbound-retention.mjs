// Mail content retention (relay-sealed or sealed to the owner's computer alike). D1 rows (messages, jobs, outbox) stay for threading
// and billing; the content objects in R2 expire:
// - raw inbound MIME, 7 days after its job finished (or after it arrived when
//   no job ran), whether or not a reply was sent;
// - run results (answer, summary, transcript), 30 days after the job finished.
// Jobs have no finished_at column. A settled reply's outbox.updated_at is the
// finish time when there is one; otherwise the job's creation time stands in,
// which is exact for relay-answered, steer and refused jobs.
// Each scheduled run handles a bounded batch so it stays within Worker limits.
import { attachmentKey } from './device-sealing.mjs';

export const RAW_MAIL_DAYS = 7;
export const RESULT_DAYS = 30;
const BATCH = 25;

// The outbox reads a job's raw MIME and result only while building the reply
// ('queued', or 'sending' which falls back to 'queued' if its copy fails).
// After that it uses its own outbound copy, so later states don't hold content.
// Used inside a NOT EXISTS over `jobs j LEFT JOIN outbox o`: true while the
// job's content is still in use or the job finished less than `days` ago.
function holds(days) {
  return `(j.state IN ('queued', 'running') OR j.steer_state = 'pending'
    OR o.state IN ('queued', 'sending')
    OR (o.state IN ('sent', 'blocked', 'accepted', 'uncertain') AND o.updated_at > datetime('now', '-${days} days'))
    OR j.created_at > datetime('now', '-${days} days'))`;
}

export async function deleteExpiredInboundMime(env) {
  const found = await env.DB.prepare(`SELECT m.id, m.object_key, m.seal_key_id FROM messages m
    WHERE m.direction = 'inbound' AND m.raw_deleted_at IS NULL
      AND m.created_at <= datetime('now', '-${RAW_MAIL_DAYS} days')
      AND NOT EXISTS (SELECT 1 FROM jobs j LEFT JOIN outbox o ON o.job_id = j.id
        WHERE j.message_id = m.id AND ${holds(RAW_MAIL_DAYS)})
    ORDER BY m.created_at, m.id LIMIT ${BATCH}`).bind().all();
  for (const row of found.results ?? found) {
    try {
      await env.MAIL.delete(row.object_key);
      // Sealed mail is kept as a request object plus one object per attachment.
      if (row.seal_key_id) for (let index = 0; index < 5; index += 1) await env.MAIL.delete(attachmentKey(row.object_key, index));
      // A "which project?" job keeps the sealed request text for routing the
      // sender's answer; it is a copy of this mail, so it goes too.
      await env.DB.batch([
        env.DB.prepare(`UPDATE messages SET raw_deleted_at = CURRENT_TIMESTAMP
          WHERE id = ? AND raw_deleted_at IS NULL`).bind(row.id),
        env.DB.prepare(`UPDATE jobs SET workspace_json = NULL
          WHERE message_id = ? AND json_type(workspace_json, '$.pending') IS NOT NULL`).bind(row.id),
      ]);
    } catch (error) { console.error('Inbound MIME deletion is delayed', error); }
  }
}

// A cleared result_key marks the result as expired; run pages then show the
// run's D1 metadata without an answer or transcript.
export async function deleteExpiredRunResults(env) {
  const found = await env.DB.prepare(`SELECT r.id, r.result_key FROM jobs r
    WHERE r.result_key IS NOT NULL AND r.state IN ('completed', 'failed')
      AND r.created_at <= datetime('now', '-${RESULT_DAYS} days')
      AND NOT EXISTS (SELECT 1 FROM jobs j LEFT JOIN outbox o ON o.job_id = j.id
        WHERE j.id = r.id AND ${holds(RESULT_DAYS)})
    ORDER BY r.created_at, r.rowid LIMIT ${BATCH}`).bind().all();
  for (const row of found.results ?? found) {
    try {
      await env.MAIL.delete(row.result_key);
      await env.DB.prepare('UPDATE jobs SET result_key = NULL WHERE id = ? AND result_key = ?')
        .bind(row.id, row.result_key).run();
    } catch (error) { console.error('Run result deletion is delayed', error); }
  }
}
