-- Tagmails no longer sends files to Google Drive. Delete the stored Drive
-- refresh tokens and file records now; the tables themselves are dropped in a
-- later migration, once no deployed Worker reads them.
DELETE FROM drive_files;
DELETE FROM drive_connections;
