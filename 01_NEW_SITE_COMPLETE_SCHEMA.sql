-- ==================================================
-- SECURE ENTRY VISITOR - COMPLETE D1 SCHEMA
-- CURRENT BASELINE: WORKER schemaVersion 5
-- NOTICE DELIVERY MODE: AFTER_RESET
--
-- USE THIS FILE ONLY FOR A NEW / EMPTY D1 DATABASE.
-- Run once, then run 90_VERIFY_D1_SETUP.sql.
-- Do NOT run the migration files after this file.
-- ==================================================

CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  client_txn_id TEXT NOT NULL UNIQUE,
  device_id TEXT,
  check_out_device_id TEXT,

  name_passport TEXT NOT NULL,
  mykad_passport TEXT NOT NULL,
  regnum TEXT NOT NULL,
  contact TEXT NOT NULL,
  visitor_pass_number TEXT NOT NULL,
  unit_number TEXT NOT NULL,

  reg_norm TEXT NOT NULL,
  id_norm TEXT NOT NULL,
  pass_norm TEXT NOT NULL,
  unit_norm TEXT NOT NULL,

  check_in_time TEXT NOT NULL,
  check_out_time TEXT,
  visit_status TEXT NOT NULL DEFAULT 'CHECKED_IN',

  image_key TEXT,
  image_sha256 TEXT,
  drive_file_id TEXT,
  drive_url TEXT,

  sync_status TEXT NOT NULL DEFAULT 'PENDING',
  sync_attempts INTEGER NOT NULL DEFAULT 0,
  sync_error TEXT NOT NULL DEFAULT '',
  sync_version INTEGER NOT NULL DEFAULT 1,

  parking_session_id TEXT,
  parking_interval_id TEXT
);

CREATE TABLE IF NOT EXISTS parking_sessions (
  id TEXT PRIMARY KEY,
  regnum TEXT NOT NULL,
  reg_norm TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'PAUSED', 'ENDED', 'REVOKED')),

  session_started_at TEXT NOT NULL,
  accumulated_seconds INTEGER NOT NULL DEFAULT 0
    CHECK (accumulated_seconds >= 0),

  current_check_in_at TEXT,
  last_check_out_at TEXT,
  reset_at TEXT,
  current_entry_id TEXT,

  last_visitor_pass_number TEXT NOT NULL DEFAULT '',
  last_unit_number TEXT NOT NULL DEFAULT '',

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  revoked_at TEXT,
  revocation_reason TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS parking_intervals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  visitor_record_id TEXT NOT NULL UNIQUE,

  check_in_time TEXT NOT NULL,
  check_out_time TEXT,
  duration_seconds INTEGER NOT NULL DEFAULT 0
    CHECK (duration_seconds >= 0),

  visitor_pass_number TEXT NOT NULL DEFAULT '',
  unit_number TEXT NOT NULL DEFAULT '',

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

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

-- ==================================================
-- ENTRIES INDEXES
-- ==================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_one_active_visitor
  ON entries(id_norm)
  WHERE visit_status = 'CHECKED_IN'
    AND (check_out_time IS NULL OR check_out_time = '')
    AND id_norm <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_one_active_pass
  ON entries(pass_norm)
  WHERE visit_status = 'CHECKED_IN'
    AND check_out_time IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_one_active_vehicle
  ON entries(reg_norm)
  WHERE visit_status = 'CHECKED_IN'
    AND (check_out_time IS NULL OR check_out_time = '')
    AND reg_norm <> '';

CREATE INDEX IF NOT EXISTS idx_entries_reg_created
  ON entries(reg_norm, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_entries_id_created
  ON entries(id_norm, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_entries_unit_created
  ON entries(unit_norm, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_entries_pass_status_created
  ON entries(pass_norm, visit_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_entries_created
  ON entries(created_at);

CREATE INDEX IF NOT EXISTS idx_entries_sync_retry
  ON entries(sync_status, sync_attempts, created_at);

CREATE INDEX IF NOT EXISTS idx_entries_parking_session
  ON entries(parking_session_id);

CREATE INDEX IF NOT EXISTS idx_entries_parking_interval
  ON entries(parking_interval_id);

-- ==================================================
-- OVERNIGHT PARKING INDEXES
-- ==================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_parking_one_open_session_per_vehicle
  ON parking_sessions(reg_norm)
  WHERE status IN ('ACTIVE', 'PAUSED')
    AND reg_norm <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_parking_one_open_interval_per_session
  ON parking_intervals(session_id)
  WHERE check_out_time IS NULL;

CREATE INDEX IF NOT EXISTS idx_parking_sessions_reg_updated
  ON parking_sessions(reg_norm, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_parking_sessions_status_reset
  ON parking_sessions(status, reset_at);

CREATE INDEX IF NOT EXISTS idx_parking_intervals_session_checkin
  ON parking_intervals(session_id, check_in_time ASC);

-- ==================================================
-- PARKING NOTICE INDEXES
-- ==================================================

CREATE INDEX IF NOT EXISTS idx_parking_notices_status_retry
  ON parking_notices(notice_status, attempts, updated_at);

CREATE INDEX IF NOT EXISTS idx_parking_notices_session
  ON parking_notices(parking_session_id);
