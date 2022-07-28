SELECT
    max(tts_sec) AS tts_sec,
    COUNT(name) AS count,
    name
FROM (
    SELECT
        tts_sec,
        name,
        PERCENT_RANK() OVER (PARTITION BY name ORDER BY tts_sec DESC) AS percentile
    FROM (
        SELECT
            DATE_DIFF(
                'second',
                PARSE_TIMESTAMP_ISO8601(workflow.created_at),
                PARSE_TIMESTAMP_ISO8601(job.completed_at)
            ) AS tts_sec,
            CONCAT(workflow.name, ' / ', job.name) as name
        FROM
            commons.workflow_job job
            JOIN commons.workflow_run workflow on workflow.id = job.run_id
        WHERE
            job.name != 'ciflow_should_run'
            AND job.name != 'generate-test-matrix'
            AND job.name != 'get_workflow_conclusion'
            AND workflow.repository.full_name = 'pytorch/pytorch'
            AND job._event_time >= PARSE_DATETIME_ISO8601(:startTime)
            AND job._event_time < PARSE_DATETIME_ISO8601(:stopTime)
            AND job.conclusion = 'success'
            AND workflow.head_branch LIKE :branch
    ) AS tts
) AS p
WHERE
    (SELECT NOT IS_NAN(p.percentile) AND p.percentile >= (1.0 - :percentile))
GROUP BY
    name
ORDER BY
    COUNT(name) * MAX(tts_sec) DESC
