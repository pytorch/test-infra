-- !!! Query is not converted to CH syntax yet.  Delete this line when it gets converted
with
    tts as (
        SELECT
            MAX(
                DATE_DIFF(
                    'second',
                    PARSE_TIMESTAMP_ISO8601(w.created_at),
                    PARSE_TIMESTAMP_ISO8601(w.updated_at)
                )
            ) as duration_sec,
            w.head_sha,
            ARBITRARY(IF(w.head_branch = 'main', 'main', 'not main')) as branch,
            MIN(PARSE_TIMESTAMP_ISO8601(w.created_at)) as created_at
        FROM
            commons.workflow_run w
        WHERE
            ARRAY_CONTAINS(['pull', 'trunk'], LOWER(w.name))
            AND PARSE_TIMESTAMP_ISO8601(w.created_at) >= PARSE_DATETIME_ISO8601(:startTime)
            AND w.head_repository.full_name = 'pytorch/pytorch'
        group by
            w.head_sha
        having
            bool_and(
                w.conclusion = 'success'
                and w.run_attempt = 1
            )
    )
select
    CAST(DATE_TRUNC('week', t.created_at) as string) AS week_bucket,
    avg(t.duration_sec / 3600.0) as avg_tts,
    t.branch
from
    tts t
group by
    week_bucket,
    t.branch
order by
    week_bucket desc,
    t.branch desc
