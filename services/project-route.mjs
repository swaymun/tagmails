import { openText } from './storage-crypto.mjs';
import { relayProjectCatalog } from '../agent/project-routing.mjs';
export * from '../agent/project-routing.mjs';

// The list holds only each project's id, name and path, sealed at rest.
// The projects of the Mac the thread runs on: its pinned Mac, or for a new
// thread `deviceId`, the Mac whose model catalog pinned it. Another Mac's
// folder paths would reach a Mac that doesn't have them.
export async function accountProjectCatalog(env, accountId, threadId = null, deviceId = null) {
  const row = await env.DB.prepare(`SELECT d.project_list_json FROM devices d
    WHERE d.account_id = ? AND d.revoked_at IS NULL AND d.project_list_json IS NOT NULL
      AND d.project_list_at >= datetime('now', '-7 days')
      AND (? IS NULL OR (SELECT device_id FROM threads WHERE id = ? AND account_id = ?) IS NULL
        OR d.id = (SELECT device_id FROM threads WHERE id = ? AND account_id = ?))
      AND (? IS NULL OR d.id = ?)
    ORDER BY d.project_list_at DESC LIMIT 1`)
    .bind(accountId, threadId, threadId, accountId, threadId, accountId, deviceId, deviceId).first();
  try { return row ? relayProjectCatalog(JSON.parse(await openText(env, row.project_list_json))) : []; }
  catch { return []; }
}

// The old columns are written only by an older Worker (while this one deploys,
// or after a rollback) and may hold README excerpts and recent session requests;
// nothing reads them, and the scheduled run clears them.
export async function clearLegacyProjectCatalogs(env) {
  await env.DB.prepare(`UPDATE devices SET project_catalog_json = NULL, project_catalog_at = NULL
    WHERE project_catalog_json IS NOT NULL`).bind().run();
}
