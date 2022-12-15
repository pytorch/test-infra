WITH recent_shas as (
    SELECT
        p.head.sha as sha
    FROM
        workflow_job j
        JOIN commons.pull_request p ON j.head_sha = p.head.sha
    where
        (
            (
                PARSE_TIMESTAMP_ISO8601(j.completed_at) > (CURRENT_TIMESTAMP() - MINUTES(:numMinutes))
                and :prNumber = 0
            )
            or :prNumber = p.number
        )
        and p.base.repo.full_name = 'pytorch/pytorch'
)
SELECT
    j.id,
    j.name,
    j.conclusion,
    j.completed_at,
    j.html_url,
    p.number AS pr_number,
    p.head.sha as head_sha,
    j.torchci_classification.captures as failure_captures,
FROM
    recent_shas
    join commons.workflow_job j ON j.head_sha = recent_shas.sha
    left outer join commons.pull_request p on p.head.sha = j.head_sha
UNION
SELECT
    w.id,
    w.name,
    w.conclusion,
    w.completed_at,
    w.html_url,
    p.number AS pr_number,
    w.head_sha,
    null as failure_line
FROM
    recent_shas
    join commons.workflow_run w ON w.head_sha = recent_shas.sha
    left outer join commons.workflow_job j on j.run_id = w.id
    left outer join commons.pull_request p on p.head.sha = w.head_sha
WHERE
    j.name is null
