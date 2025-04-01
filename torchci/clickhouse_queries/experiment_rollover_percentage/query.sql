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
    experiment_jobs AS (
        SELECT
            DISTINCT j.job_name
        FROM
            normalized_jobs AS j
        WHERE
            match(j.label, concat('(?-s)(lf.)?([[:alnum:]]\\.)*?', {experiment_name: String}, '(\\..)+'))
    ),
    comparable_jobs AS (
        SELECT
            j.bucket,
            j.label,
            j.job_name,
            -- Remove shard number and label from job names
            j.workflow_name
        FROM
            normalized_jobs AS j
        INNER JOIN
            experiment_jobs AS lfj ON j.job_name = lfj.job_name
    ),
    success_stats AS (
        SELECT
            count(*) AS group_size,
            bucket,
            replaceOne(replaceOne(label, 'lf.', ''), concat({experiment_name: String}, '.'), '') AS label_ref,
            if(match(label, concat('(?-s)(lf.)?([[:alnum:]]\\.)*?', {experiment_name: String}, '(\\..)+')), True, False) AS is_ephemeral_exp
        FROM
            comparable_jobs
        GROUP BY
            bucket, label_ref, is_ephemeral_exp
    ),
    comparison_stats AS (
        SELECT
            experiment.bucket,
            SUM(experiment.group_size + m.group_size) AS total_jobs,
            SUM(m.group_size) AS compliment_jobs,
            SUM(experiment.group_size) AS counted_jobs,
            m.is_ephemeral_exp AS c_fleet,
            experiment.is_ephemeral_exp AS m_fleet,
            CAST(SUM(experiment.group_size) AS Float32) / SUM(experiment.group_size + m.group_size) * 100 AS percentage,
            IF(experiment.is_ephemeral_exp, 'On experiment', 'Not on experiment') AS fleet
        FROM
            success_stats AS experiment
        INNER JOIN
            success_stats AS m
        ON
            experiment.label_ref = m.label_ref
            AND experiment.bucket = m.bucket
        WHERE
            experiment.is_ephemeral_exp = 1 AND m.is_ephemeral_exp = 0
        GROUP BY
            experiment.bucket, experiment.is_ephemeral_exp, m.is_ephemeral_exp
    )
SELECT * FROM comparison_stats
ORDER BY  bucket DESC
