WITH
    normalized_jobs AS (
        SELECT
            l AS label,
            extract(j.name, '[^,]*') AS job_name, -- Remove shard number and label from job names
            j.workflow_name,
            toStartOfInterval(j.started_at, INTERVAL 1 HOUR) AS bucket
        FROM
            workflow_job AS j
            ARRAY JOIN j.labels as l
        WHERE
            j.created_at > now() - INTERVAL {days_ago: Int64} DAY
            AND j.status = 'completed'
            AND l != 'self-hosted'
            AND l NOT LIKE 'lf.c.%'
            AND l NOT LIKE '%canary%'
    ),
    lf_jobs AS (
        SELECT
            DISTINCT j.job_name
        FROM
            normalized_jobs AS j
        WHERE
            j.label LIKE 'lf%'
    ),
    -- filter jobs down to the ones that ran in both
    -- LF and Meta fleets
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
            lf_jobs AS lfj ON j.job_name = lfj.job_name
    ),
    success_stats AS (
        SELECT
            bucket,
            count(*) AS group_size,
            job_name,
            workflow_name,
            label,
            if(substring(label, 1, 3) = 'lf.', True, False) AS lf_fleet
        FROM
            comparable_jobs
        GROUP BY
            bucket, job_name, workflow_name, label
    ),
    comparison_stats AS (
        SELECT
            lf.bucket,
            SUM(lf.group_size + m.group_size) AS total_jobs,
            SUM(m.group_size) AS compliment_jobs,
            SUM(lf.group_size) AS counted_jobs,
            m.lf_fleet AS c_fleet,
            lf.lf_fleet AS m_fleet,
            CAST(SUM(lf.group_size) AS Float32) / SUM(lf.group_size + m.group_size) * 100 AS percentage,
            IF(lf.lf_fleet, 'Linux Foundation', 'Meta') AS fleet
        FROM
            success_stats AS lf
        INNER JOIN
            success_stats AS m ON lf.bucket = m.bucket
        WHERE
            lf.job_name = m.job_name
            AND lf.workflow_name = m.workflow_name
            AND (
                (lf.lf_fleet = 1 AND m.lf_fleet = 0)
                OR (lf.lf_fleet = 0 AND m.lf_fleet = 1)
            )
            AND lf.group_size > 3
            AND m.group_size > 3
        GROUP BY
            lf.bucket, lf.lf_fleet, m.lf_fleet
    )
SELECT * FROM comparison_stats
ORDER BY  bucket DESC, fleet