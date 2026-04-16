SELECT
    DISTINCT arrayJoin(labels) AS machine_type
FROM
    default .workflow_job
where
    created_at > now() - interval 3 day
