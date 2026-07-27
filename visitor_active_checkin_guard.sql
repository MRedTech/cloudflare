-- ==================================================
-- SECURE ENTRY VISITOR - ACTIVE VISITOR GUARD
-- Run once in Cloudflare D1 Console for the existing Visitor database.
-- Prevents one MyKad / Passport from having two active CHECKED_IN records.
-- ==================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_one_active_visitor
  ON entries(id_norm)
  WHERE visit_status = 'CHECKED_IN'
    AND (check_out_time IS NULL OR check_out_time = '')
    AND id_norm <> '';
