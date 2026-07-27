-- ==================================================
-- SECURE ENTRY VISITOR - OVERNIGHT PARKING MIGRATION
-- Run ONCE on the existing Visitor Sensory D1 database.
-- Existing visitor records remain unchanged.
-- New check-ins will be linked to parking sessions and intervals.
-- ==================================================

ALTER TABLE entries ADD COLUMN parking_session_id TEXT;
ALTER TABLE entries ADD COLUMN parking_interval_id TEXT;

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

-- One vehicle can have only one open parking session (ACTIVE or PAUSED).
CREATE UNIQUE INDEX IF NOT EXISTS idx_parking_one_open_session_per_vehicle
  ON parking_sessions(reg_norm)
  WHERE status IN ('ACTIVE', 'PAUSED')
    AND reg_norm <> '';

-- One parking session can have only one interval currently inside the property.
CREATE UNIQUE INDEX IF NOT EXISTS idx_parking_one_open_interval_per_session
  ON parking_intervals(session_id)
  WHERE check_out_time IS NULL;

CREATE INDEX IF NOT EXISTS idx_parking_sessions_reg_updated
  ON parking_sessions(reg_norm, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_parking_sessions_status_reset
  ON parking_sessions(status, reset_at);

CREATE INDEX IF NOT EXISTS idx_parking_intervals_session_checkin
  ON parking_intervals(session_id, check_in_time ASC);

CREATE INDEX IF NOT EXISTS idx_entries_parking_session
  ON entries(parking_session_id);

CREATE INDEX IF NOT EXISTS idx_entries_parking_interval
  ON entries(parking_interval_id);

-- Hard protection for overnight logic: the same vehicle cannot be checked in twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_one_active_vehicle
  ON entries(reg_norm)
  WHERE visit_status = 'CHECKED_IN'
    AND (check_out_time IS NULL OR check_out_time = '')
    AND reg_norm <> '';
