-- ==================================================
-- SECURE ENTRY VISITOR - OVERNIGHT PARKING NOTICE
-- Run once in the existing Sensory Visitor D1 database
-- BEFORE deploying Worker schemaVersion 4.
-- This creates a new table only. Existing tables/functions are not changed.
-- ==================================================

CREATE TABLE IF NOT EXISTS parking_notices (
  id TEXT PRIMARY KEY,
  notice_number TEXT NOT NULL UNIQUE,
  parking_session_id TEXT NOT NULL UNIQUE,
  visitor_record_id TEXT NOT NULL,

  visitor_name TEXT NOT NULL DEFAULT '',
  regnum TEXT NOT NULL,
  unit_number TEXT NOT NULL,
  visitor_pass_number TEXT NOT NULL,

  session_started_at TEXT NOT NULL,
  final_check_out_at TEXT NOT NULL,
  total_duration_seconds INTEGER NOT NULL DEFAULT 0,
  free_seconds INTEGER NOT NULL DEFAULT 86400,
  charge_blocks INTEGER NOT NULL DEFAULT 0,
  rate_cents INTEGER NOT NULL DEFAULT 1000,
  total_charge_cents INTEGER NOT NULL DEFAULT 0,

  notice_status TEXT NOT NULL DEFAULT 'PENDING',
  notice_version INTEGER NOT NULL DEFAULT 1,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,

  pdf_file_id TEXT,
  pdf_url TEXT,
  email_to TEXT,
  email_sent_at TEXT,
  email_error TEXT NOT NULL DEFAULT '',

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_parking_notices_status_retry
  ON parking_notices(notice_status, attempts, updated_at);

CREATE INDEX IF NOT EXISTS idx_parking_notices_session
  ON parking_notices(parking_session_id);
