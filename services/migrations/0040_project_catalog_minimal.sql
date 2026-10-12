-- The relay now keeps only each project's id, name and path (agent/project-routing.mjs
-- relayProjectCatalog), in new columns only this Worker writes. The old columns also
-- held README excerpts, top-level entries and recent session requests; they are
-- cleared here and, for anything an older Worker writes there while this one deploys
-- (or after a rollback), by the scheduled cleanup (services/project-route.mjs
-- clearLegacyProjectCatalogs). Each computer republishes at its next refresh
-- (every 15 minutes, and on restart).
ALTER TABLE devices ADD COLUMN project_list_json TEXT;
ALTER TABLE devices ADD COLUMN project_list_at TEXT;
UPDATE devices SET project_catalog_json = NULL, project_catalog_at = NULL WHERE project_catalog_json IS NOT NULL;
