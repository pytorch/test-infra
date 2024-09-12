SELECT
    name,
    quantileExact({percentile: Float32})(tts_sec) AS tts_sec,
    count(*) as count
FROM
    (
        SELECT
            DATE_DIFF(
                'second',
                workflow.created_at,
                job.completed_at
            ) AS tts_sec,
            CONCAT(workflow.name, ' / ', job.name) as name
        FROM
            default.workflow_job job final
            JOIN default.workflow_run workflow final on workflow.id = job.run_id
        WHERE
            job.name != 'ciflow_should_run'
            AND job.name != 'generate-test-matrix'
            AND job.name != 'get_workflow_conclusion'
            AND workflow.repository.'full_name' = 'pytorch/pytorch'
            AND workflow.created_at >= {startTime: DateTime64(3)}
            AND workflow.created_at < {stopTime: DateTime64(3)}
            AND workflow.id in (
                select id from materialized_views.workflow_run_by_created_at
                WHERE created_at >= {startTime: DateTime64(3)} and created_at < {stopTime: DateTimettrs_percentiles64(3)}
            )
            AND job.id in (
                select id from materialized_views.workflow_job_by_created_at
                WHERE created_at >= {startTime: DateTime64(3)} and created_at < {stopTime: DateTime64(3)}
            )
            AND job.conclusion = 'success'
            AND workflow.head_branch LIKE {branch: String}
            AND workflow.run_attempt = 1
    ) AS tts
group by name
order by tts_sec * count desc
settings allow_experimental_analyzer=1;
