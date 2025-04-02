WITH
    normalized_jobs AS (
        SELECT
            l AS label,
            extract(j.name, '[^,]*') AS job_name, -- Remove shard number and label from job names
            j.workflow_name,
            toStartOfInterval(j.created_at, INTERVAL 1 HOUR) AS bucket
        FROM
            -- Deliberatly not adding FINAL to this workflow_job.
            -- Risks of not using it:
            --   - You may get duplicate records for rows that were updated corresponding to their
            --     before/after states, but as long as there’s some mechanism in the query to account
            --     for that it’s okay (we check for j.status = 'completed`).
            --   - In the worst case scenario, you may only see the ‘old’ version of the records for some rows
            -- Costs of using it:
            --   - Query procesing time increases from ~5 -> 16 seconds
            --   - Memory usage grows from 7.5 GB -> 32 GB
            -- So the tradeoff is worth it for this query.
            workflow_job AS j
            ARRAY JOIN j.labels as l
        WHERE
            j.created_at > now() - INTERVAL {days_ago: Int64} DAY
            AND j.status = 'completed'
            AND l != 'self-hosted'
            AND l NOT LIKE 'lf.c.%'
            AND l NOT LIKE '%.canary'
            AND l NOT LIKE 'c.%'
    ),
    lf_jobs AS (
        SELECT
            DISTINCT j.job_name
        FROM
            normalized_jobs AS j
        WHERE
            j.label LIKE 'lf.%'
    ),
    comparable_jobs AS (
        SELECT
            j.bucket,
            j.label,
            j.job_name,
            j.workflow_name
        FROM
            normalized_jobs AS j
        INNER JOIN
            lf_jobs AS lfj ON j.job_name = lfj.job_name
    ),
    success_stats AS (
        SELECT
            count(*) AS group_size,
            bucket,
            replaceOne(label, 'lf.', '') AS label_ref,
            if(substring(label, 1, 3) = 'lf.', True, False) AS lf_fleet
        FROM
            comparable_jobs
        GROUP BY
            bucket, label_ref, lf_fleet
    ),
    lf_success_stats AS (
        SELECT
            *
        FROM
            success_stats
        WHERE
            lf_fleet = True
    ),
    meta_success_stats AS (
        SELECT
            *
        FROM
            success_stats
        WHERE
            lf_fleet = False
    ),
    comparison_stats AS (
        SELECT
            -- *
            greatest(lf.bucket, m.bucket) AS bucket,
            CAST(SUM(lf.group_size) AS Float32) / SUM(lf.group_size + m.group_size) * 100 AS percentage,
            -- IF(lf.lf_fleet, 'Linux Foundation', 'Meta') AS fleet
            'Linux Fundation' AS fleet
        FROM
            lf_success_stats AS lf
        FULL OUTER JOIN
            meta_success_stats AS m
        ON
            lf.label_ref = m.label_ref
            AND lf.bucket = m.bucket
        GROUP BY
            bucket
    )
SELECT
    bucket,
    fleet,
    avg(percentage) OVER (ORDER BY bucket DESC ROWS BETWEEN 5 PRECEDING AND CURRENT ROW) AS percentage
FROM
    comparison_stats
ORDER BY
    bucket DESC
