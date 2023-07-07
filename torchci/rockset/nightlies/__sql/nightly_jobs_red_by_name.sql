SELECT
            COUNT(*) COUNT, workflow.name
        FROM
            commons.workflow_job job
            JOIN commons.workflow_run workflow on workflow.id = job.run_id
            JOIN push on workflow.head_commit.id = push.head_commit.id
        WHERE
            job.name NOT LIKE '%generate-matrix%'
            AND job.name NOT LIKE '%unittests%'
            AND workflow.name NOT IN ('cron', 'Bandit', 'tests', 'Lint')
            AND push.ref = 'refs/heads/nightly'
            AND push.repository.owner.name = 'pytorch'
            AND push.repository.name in ('pytorch', 'vision', 'audio', 'text')
            AND job._event_time >= PARSE_DATETIME_ISO8601(:startTime)
            AND job._event_time < PARSE_DATETIME_ISO8601(:stopTime)
            AND job.conclusion in ('failure', 'timed_out', 'cancelled')
  GROUP BY
  workflow.name
  ORDER BY COUNT DESC
