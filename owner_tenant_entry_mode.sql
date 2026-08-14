-- SECURE ENTRY OWNER | TENANT - FINDING #6
-- D1 migration: explicit NORMAL / DEFAULTER entry mode
--
-- SAFE ORDER:
-- 1) Deploy Finding #6 GAS first.
-- 2) Run STEP A + STEP B + STEP C below in D1.
-- 3) Deploy Finding #6 Worker.
-- 4) Run STEP B + STEP C again once to catch any registration
--    that may have arrived during the deployment gap.
--
-- STEP A: Add the new mode column.
-- Run ONCE only.
ALTER TABLE entries
ADD COLUMN entry_mode TEXT NOT NULL DEFAULT 'NORMAL';

-- STEP B: Backfill existing records safely.
-- Historical NORMAL records that used REASON=DEFAULTER and still have an ID
-- remain NORMAL. Dedicated DEFAULTER audit records have blank id_norm.
UPDATE entries
SET entry_mode = CASE
  WHEN UPPER(TRIM(reason)) = 'DEFAULTER'
   AND COALESCE(TRIM(id_norm), '') = ''
  THEN 'DEFAULTER'
  ELSE 'NORMAL'
END;

-- STEP C: Verify the migration result.
SELECT entry_mode, COUNT(*) AS count
FROM entries
GROUP BY entry_mode
ORDER BY entry_mode;
