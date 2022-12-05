WITH recent_shas as (
    SELECT
        j.head_sha as sha
    FROM
        workflow_job j
    where
        PARSE_TIMESTAMP_ISO8601(j.completed_at) > (CURRENT_TIMESTAMP() - MINUTES(:numMinutes))
        and :prNumber = 0
    union
    select
        p.head.sha as sha
    from
        commons.pull_request p
    where
        p.number = :prNumber
)
SELECT
    j.id AS id,
    j.name AS name,
    j.conclusion,
    j.completed_at,
    j.html_url,
    p.number AS pr_number,
    p.head.sha AS sha,
FROM
    commons.workflow_job j
    INNER JOIN commons.pull_request p ON j.head_sha = p.head.sha
WHERE
    p.head.sha IN (
        SELECT
            *
        FROM
            recent_shas
    )
    AND p.base.repo.full_name = 'pytorch/pytorch'
UNION
SELECT
    w.id,
    w.name,
    w.conclusion,
    w.completed_at,
    w.html_url,
    p.number AS pr_number,
    p.head.sha AS sha,
FROM
    commons.workflow_run w
    LEFT OUTER JOIN commons.workflow_job j on j.run_id = w.id
    INNER JOIN commons.pull_request p ON w.head_commit.id = p.head.sha
WHERE
    j.name is null
    and p.head.sha IN (
        SELECT
            *
        FROM
            recent_shas
    )
    AND p.base.repo.full_name = 'pytorch/pytorch'
