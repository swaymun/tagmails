-- Project routing: the paired machine publishes its recent project folders and
-- each job records the folder chosen for it (or a scratch folder / pending question).
ALTER TABLE devices ADD COLUMN project_catalog_json TEXT;
ALTER TABLE devices ADD COLUMN project_catalog_at TEXT;
ALTER TABLE jobs ADD COLUMN workspace_json TEXT;
