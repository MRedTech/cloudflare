-- ==================================================
-- SECURE ENTRY OWNER | TENANT - SENSORY
-- D1 SCHEMA
-- ==================================================

-- Registration records
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  client_txn_id TEXT NOT NULL UNIQUE,
  device_id TEXT,

  name_passport TEXT,
  mykad_passport TEXT,
  regnum TEXT,
  contact TEXT,
  unit_number TEXT,
  category TEXT,
  reason TEXT,
  reason_other TEXT,
  tower TEXT,

  reg_norm TEXT,
  id_norm TEXT,
  unit_norm TEXT,

  image_key TEXT,
  image_sha256 TEXT,
  drive_file_id TEXT,
  drive_url TEXT,

  sync_status TEXT,
  sync_attempts INTEGER DEFAULT 0,
  sync_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_entries_reg_created
  ON entries(reg_norm, created_at);

CREATE INDEX IF NOT EXISTS idx_entries_id_created
  ON entries(id_norm, created_at);

CREATE INDEX IF NOT EXISTS idx_entries_unit_created
  ON entries(unit_norm, created_at);

CREATE INDEX IF NOT EXISTS idx_entries_created
  ON entries(created_at);

CREATE INDEX IF NOT EXISTS idx_entries_sync_created
  ON entries(sync_status, created_at);

-- Owner reference directory
-- Multiple owners for the same unit use owner_order = 1, 2, 3 ...
-- Units with no owner name may still be stored with owner_name = ''.
CREATE TABLE IF NOT EXISTS unit_owners (
  id TEXT PRIMARY KEY,
  unit_number TEXT NOT NULL,
  unit_norm TEXT NOT NULL,
  owner_name TEXT DEFAULT '',
  owner_order INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_unit_owners_lookup
  ON unit_owners(unit_norm, is_active, owner_order);
