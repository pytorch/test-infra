SELECT
    w.name AS job_name,
    w.conclusion,
    w.completed_at,
    w.html_url,
    w.head_sha,
    w.run_attempt,
    p.number AS pr_number,
    p.user.login AS owner_login,
FROM
    commons.workflow_job w INNER JOIN commons.pull_request p ON w.head_sha = p.head.sha
WHERE
    w.head_sha IN (
        SELECT
            w.head_sha
        FROM
            commons.workflow_job w
        WHERE
            PARSE_TIMESTAMP_ISO8601(w.completed_at) > (CURRENT_TIMESTAMP() - MINUTES(:numMinutes))
    )
    AND w.head_sha = p.head.sha
    AND p.base.repo.full_name = 'pytorch/pytorch'

GROUP BY
    job_name,
    conclusion,
    completed_at,
    html_url,
    head_sha,
    run_attempt,
    pr_number,
    owner_login
