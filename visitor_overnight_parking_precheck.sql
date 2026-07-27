-- Run this BEFORE the overnight parking migration.
-- Expected result: no rows.
-- If rows appear, check out or correct the duplicate active vehicle records first.
SELECT
  reg_norm,
  COUNT(*) AS active_records,
  GROUP_CONCAT(id) AS record_ids
FROM entries
WHERE visit_status = 'CHECKED_IN'
  AND (check_out_time IS NULL OR check_out_time = '')
  AND reg_norm <> ''
GROUP BY reg_norm
HAVING COUNT(*) > 1;
