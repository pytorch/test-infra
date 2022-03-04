SELECT
    c.rule,
    c.captures,
    COUNT(*) as num,
from
    "GitHub-Actions".classification c
    JOIN commons.workflow_job j on j.id = c.job_id
    JOIN commons.workflow_run w on w.id = j.run_id
    JOIN commons.push push on w.head_commit.id = push.head_commit.id
WHERE
    push.ref = 'refs/heads/master'
    AND push.repository.owner.name = 'pytorch'
    AND push.repository.name = 'pytorch'
    AND c._event_time >= PARSE_DATETIME_ISO8601(:startTime)
    AND c._event_time < PARSE_DATETIME_ISO8601(:stopTime)
GROUP BY
    c.rule,
    c.captures
ORDER BY
    num DESC
