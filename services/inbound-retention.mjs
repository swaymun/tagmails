// Keep message IDs for thread routing, but remove the raw MIME and its
// attachments seven days after the associated reply is settled or blocked.
export async function deleteSettledInboundMime(env) {
  const found = await env.DB.prepare(`SELECT m.id, m.object_key FROM messages m
    JOIN jobs j ON j.message_id = m.id JOIN outbox o ON o.job_id = j.id
    WHERE m.direction = 'inbound' AND m.raw_deleted_at IS NULL
      AND m.created_at <= datetime('now', '-7 days')
      AND j.state IN ('completed', 'failed') AND o.state IN ('sent', 'blocked')
    ORDER BY m.created_at, m.id LIMIT 50`).bind().all();
  for (const row of found.results ?? found) {
    try {
      await env.MAIL.delete(row.object_key);
      await env.DB.prepare(`UPDATE messages SET raw_deleted_at = CURRENT_TIMESTAMP
        WHERE id = ? AND raw_deleted_at IS NULL`).bind(row.id).run();
    } catch (error) { console.error('Inbound MIME deletion is delayed', error); }
  }
}
