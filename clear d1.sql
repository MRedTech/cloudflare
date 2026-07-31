D1 → visitor_sensory → Console
===============================
PRAGMA defer_foreign_keys = ON;

DELETE FROM parking_notices;
DELETE FROM parking_intervals;
DELETE FROM entries;
DELETE FROM parking_sessions;

PRAGMA defer_foreign_keys = OFF;
==============================
semak

SELECT 'entries' AS table_name, COUNT(*) AS total FROM entries
UNION ALL
SELECT 'parking_sessions', COUNT(*) FROM parking_sessions
UNION ALL
SELECT 'parking_intervals', COUNT(*) FROM parking_intervals
UNION ALL
SELECT 'parking_notices', COUNT(*) FROM parking_notices;
=============================
aktifkan semula cron

*/5 * * * *
