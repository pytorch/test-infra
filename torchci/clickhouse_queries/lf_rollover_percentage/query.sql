WITH
    normalized_jobs AS (
        SELECT
            extract(j.name, '[^,]*') AS job_name, -- Remove shard number and label from job names
            match(l, '^lf[.-]') AS is_lf,
            DATE_TRUNC({granularity: String}, j.created_at) AS bucket
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
            j.created_at >= {startTime: DateTime64(3)}
            AND j.created_at < {stopTime: DateTime64(3)}
            AND j.status = 'completed'
            AND l != 'self-hosted'
            AND l NOT LIKE 'lf.c.%'
            AND l NOT LIKE '%.canary'
            AND l NOT LIKE 'c.%'
            AND l NOT LIKE 'c-%'
    ),
    lf_jobs AS (
        SELECT
            DISTINCT job_name
        FROM
            normalized_jobs
        WHERE
            is_lf
    ),
    comparable_jobs AS (
        SELECT
            j.bucket,
            j.is_lf
        FROM
            normalized_jobs AS j
        INNER JOIN
            lf_jobs AS lfj ON j.job_name = lfj.job_name
    ),
    comparison_stats AS (
        SELECT
            bucket,
            CAST(countIf(is_lf) AS Float32) / count(*) * 100 AS percentage,
            'Linux Foundation' AS fleet
        FROM
            comparable_jobs
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
