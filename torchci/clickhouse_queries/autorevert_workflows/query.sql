-- Get distinct workflow names from autorevert events
-- Used for workflow selector in autorevert metrics page
-- Only shows workflows that autorevert actually monitors
SELECT
    workflow AS workflow_name,
    count() AS run_count
FROM misc.autorevert_events_v2 a FINAL
ARRAY JOIN a.workflows AS workflow
WHERE
    a.repo = 'pytorch/pytorch'
    AND a.ts >= now() - INTERVAL 90 DAY
GROUP BY workflow
ORDER BY run_count DESC
