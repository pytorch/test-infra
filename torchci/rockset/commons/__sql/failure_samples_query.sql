WITH classifications AS (
    SELECT
        c.job_id,
        c._event_time,
        c.line,
        c.line_num,
        c.context,
        -- c.captures can be an array or a string type. Make it always be a string
        CASE
            IS_SCALAR(c.captures)
            WHEN true THEN c.captures
            WHEN false THEN ARRAY_JOIN(c.captures, '\n')
        END AS captures,
    FROM
        "GitHub-Actions".classification c
    WHERE
        c._event_time > (CURRENT_TIMESTAMP() - INTERVAL 14 day)
)
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
    c.line AS failureLine,
    c.line_num AS failureLineNumber,
    c.context AS failureContext,
    c.captures AS failureCaptures,
FROM
    classifications c
    JOIN commons.workflow_job job ON job.id = c.job_id
    JOIN commons.workflow_run w HINT(access_path = column_scan) ON w.id = job.run_id
WHERE
    w.head_branch LIKE :branch
    AND w.repository.full_name = :repo
    AND c.captures LIKE FORMAT('%{}%', :captures)
ORDER BY
    c._event_time DESC
