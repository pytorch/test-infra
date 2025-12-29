-- Get distinct workflow names from recent CI runs
-- Used for workflow selector in autorevert metrics page
-- Only includes main CI workflows (not auxiliary/bot workflows)
SELECT
    workflow_run.name AS workflow_name,
    count() AS run_count
FROM workflow_run FINAL
WHERE
    workflow_run.repository.'full_name' = 'pytorch/pytorch'
    AND workflow_run.name != ''
    AND workflow_run.event != 'workflow_run'
    AND workflow_run.created_at >= now() - INTERVAL 30 DAY
    -- Filter to main CI workflows (exclude bot/auxiliary workflows)
    AND workflow_run.name NOT LIKE '%bot%'
    AND workflow_run.name NOT LIKE '%Bot%'
    AND workflow_run.name NOT LIKE 'Create%'
    AND workflow_run.name NOT LIKE 'Close%'
    AND workflow_run.name NOT LIKE 'Delete%'
    AND workflow_run.name NOT LIKE 'Check%'
    AND workflow_run.name NOT LIKE 'Update%'
    AND workflow_run.name NOT LIKE 'Apply%'
    AND workflow_run.name NOT LIKE 'Auto%'
    AND workflow_run.name NOT LIKE 'Rebase%'
    AND workflow_run.name NOT LIKE 'Revert%'
    AND workflow_run.name NOT LIKE 'Index%'
    AND workflow_run.name NOT LIKE 'Running%'
    AND workflow_run.name NOT LIKE 'Nightly%'
    AND workflow_run.name NOT LIKE 'Sonar%'
    AND workflow_run.name NOT LIKE 'CodeQL%'
    AND workflow_run.name NOT LIKE 'Copilot%'
    AND workflow_run.name NOT LIKE 'Build%'
    AND workflow_run.name NOT LIKE 'Test%'
    AND workflow_run.name NOT LIKE '.github%'
GROUP BY workflow_run.name
HAVING run_count > 100
ORDER BY run_count DESC
