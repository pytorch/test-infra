WITH jobs AS (
    SELECT
        j.torchci_classification.line AS line,
        j.torchci_classification.captures AS captures,
        j.run_id
    FROM
        default.workflow_job j FINAL
    WHERE
        j.id IN (
            SELECT id FROM materialized_views.workflow_job_by_created_at
            WHERE
                created_at >= {startTime: DateTime64(3)}
                AND created_at < {stopTime: DateTime64(3)}
        )
        AND j.conclusion IN ('cancelled', 'failure', 'time_out')
)

SELECT
    COUNT(*) AS num,
    any(line) AS example,
    captures AS captures
FROM
    jobs j
JOIN default.workflow_run w FINAL ON w.id = j.run_id
WHERE
    w.id IN (SELECT run_id FROM jobs)
    AND w.head_branch = 'main'
    AND w.head_repository.'full_name' = 'pytorch/pytorch'
    AND w.event != 'workflow_run'
    AND w.event != 'repository_dispatch'
GROUP BY
    captures
ORDER BY
    COUNT(*) DESC
