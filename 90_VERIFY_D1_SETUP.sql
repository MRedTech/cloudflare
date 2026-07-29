-- ==================================================
-- SECURE ENTRY VISITOR - FINAL D1 VERIFICATION
-- Run after either the new-site schema or existing-site migrations.
-- ==================================================

-- SUMMARY: every result should be OK.
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'entries'
  ) THEN 'OK' ELSE 'MISSING' END AS entries_table,

  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'parking_sessions'
  ) THEN 'OK' ELSE 'MISSING' END AS parking_sessions_table,

  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'parking_intervals'
  ) THEN 'OK' ELSE 'MISSING' END AS parking_intervals_table,

  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'parking_notices'
  ) THEN 'OK' ELSE 'MISSING' END AS parking_notices_table,

  CASE WHEN EXISTS (
    SELECT 1 FROM pragma_table_info('entries') WHERE name = 'parking_session_id'
  ) THEN 'OK' ELSE 'MISSING' END AS parking_session_id_column,

  CASE WHEN EXISTS (
    SELECT 1 FROM pragma_table_info('entries') WHERE name = 'parking_interval_id'
  ) THEN 'OK' ELSE 'MISSING' END AS parking_interval_id_column;

-- FINAL TABLE LIST: expected 4 rows.
SELECT name AS secure_entry_table
FROM sqlite_schema
WHERE type = 'table'
  AND name IN ('entries', 'parking_sessions', 'parking_intervals', 'parking_notices')
ORDER BY name;

-- FINAL INDEX LIST.
SELECT name AS index_name, tbl_name AS table_name
FROM sqlite_schema
WHERE type = 'index'
  AND name LIKE 'idx_%'
ORDER BY tbl_name, name;
