SELECT DISTINCT
    REGEXP_EXTRACT(j.name, '^(.*) /', 1) AS base_name
FROM
    default.workflow_job j
WHERE j.created_at > now() - INTERVAL 1 MONTH
