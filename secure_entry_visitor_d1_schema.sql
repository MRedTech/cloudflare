-- ==================================================
-- SECURE ENTRY VISITOR - D1 SCHEMA
-- Run this on the NEW visitor-project D1 database.
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
  sync_version INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_one_active_visitor
  ON entries(id_norm)
  WHERE visit_status = 'CHECKED_IN'
    AND (check_out_time IS NULL OR check_out_time = '')
    AND id_norm <> '';

CREATE INDEX IF NOT EXISTS idx_entries_reg_created
  ON entries(reg_norm, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_entries_id_created
  ON entries(id_norm, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_entries_unit_created
  ON entries(unit_norm, created_at DESC);

-- Hard protection: one pass can belong to only one active visitor.
CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_one_active_pass
  ON entries(pass_norm)
  WHERE visit_status = 'CHECKED_IN'
    AND check_out_time IS NULL;

CREATE INDEX IF NOT EXISTS idx_entries_pass_status_created
  ON entries(pass_norm, visit_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_entries_created
  ON entries(created_at);

CREATE INDEX IF NOT EXISTS idx_entries_sync_retry
  ON entries(sync_status, sync_attempts, created_at);
