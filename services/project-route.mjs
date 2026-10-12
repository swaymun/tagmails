import { openText } from './storage-crypto.mjs';
import { cleanProjectCatalog } from '../agent/project-routing.mjs';
export * from '../agent/project-routing.mjs';

// The thread's own machine, or the account's most recently refreshed one. The
// list is sealed at rest: its recent requests quote the owner's own prompts.
// The projects of the Mac the thread runs on: its pinned Mac, or for a new
// thread `deviceId`, the Mac whose model catalog pinned it. Another Mac's
// folder paths would reach a Mac that doesn't have them.
export async function accountProjectCatalog(env, accountId, threadId = null, deviceId = null) {
  const row = await env.DB.prepare(`SELECT d.project_catalog_json FROM devices d
    WHERE d.account_id = ? AND d.revoked_at IS NULL AND d.project_catalog_json IS NOT NULL
      AND d.project_catalog_at >= datetime('now', '-7 days')
      AND (? IS NULL OR (SELECT device_id FROM threads WHERE id = ? AND account_id = ?) IS NULL
        OR d.id = (SELECT device_id FROM threads WHERE id = ? AND account_id = ?))
      AND (? IS NULL OR d.id = ?)
    ORDER BY d.project_catalog_at DESC LIMIT 1`)
    .bind(accountId, threadId, threadId, accountId, threadId, accountId, deviceId, deviceId).first();
  try { return row ? cleanProjectCatalog(JSON.parse(await openText(env, row.project_catalog_json))) : []; }
  catch { return []; }
}
