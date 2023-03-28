WITH
    recent_shas as (
        SELECT
            p.head.sha as sha,
            p.number as number,
            PARSE_TIMESTAMP_ISO8601(push.head_commit.timestamp) as sha_time,
        FROM
            workflow_job j
            JOIN commons.pull_request p ON j.head_sha = p.head.sha
            JOIN commons.push push on push.head_commit.id = j.head_sha
        where
            (
                (
                    PARSE_TIMESTAMP_ISO8601(j.completed_at) > (CURRENT_TIMESTAMP() - MINUTES(:numMinutes))
                    and :prNumber = 0
                )
                or :prNumber = p.number
            )
            and p.base.repo.full_name = :repo
    )
SELECT
    w.id as workflow_id,
    j.id,
    j.name,
    j.conclusion,
    j.completed_at,
    j.html_url,
    recent_shas.number AS pr_number,
    recent_shas.sha as head_sha,
    j.torchci_classification.captures as failure_captures,
    recent_shas.sha_time
FROM
    recent_shas
    join commons.workflow_job j ON j.head_sha = recent_shas.sha
    join commons.workflow_run w on w.id = j.run_id
UNION
SELECT
    null as workflow_name,
    w.id,
    w.name as name,
    w.conclusion,
    w.completed_at,
    w.html_url,
    recent_shas.number AS pr_number,
    w.head_sha,
    null as failure_line,
    recent_shas.sha_time
FROM
    recent_shas
    join commons.workflow_run w ON w.head_sha = recent_shas.sha
