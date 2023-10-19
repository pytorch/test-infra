SELECT
    job._event_time AS time,
    w.name AS workflowName,
    job.name AS jobName,
    CONCAT(w.name, ' / ', job.name) AS name,
    w.head_sha AS sha,
    job.id AS id,
    w.head_branch as branch,
    CASE
        WHEN job.conclusion IS NULL THEN 'pending'
        ELSE job.conclusion
    END AS conclusion,
    job.html_url AS htmlUrl,
    CONCAT(
        'https://ossci-raw-job-status.s3.amazonaws.com/log/',
        CAST(job.id AS string)
    ) AS logUrl,
    DATE_DIFF(
        'SECOND',
        PARSE_TIMESTAMP_ISO8601(job.started_at),
        PARSE_TIMESTAMP_ISO8601(job.completed_at)
    ) AS durationS,
    ARRAY_CREATE(job.torchci_classification.line) AS failureLines,
    ARRAY_CREATE(job.torchci_classification.line_num) AS failureLineNumbers,
    job.torchci_classification.context AS failureContext,
    job.torchci_classification.captures AS failureCaptures,
FROM
    commons.workflow_job job
    JOIN commons.workflow_run w HINT(access_path = column_scan) ON w.id = job.run_id
WHERE
    w.head_branch LIKE :branch
    AND w.head_repository.full_name = :repo
    AND job.torchci_classification.line LIKE FORMAT('%{}%', REGEXP_REPLACE(:captures, ',', '%'))
ORDER BY
    job.torchci_classification._event_time DESC
