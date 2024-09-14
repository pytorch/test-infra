WITH
    normalized_jobs AS (
        SELECT
            if(
                strpos(l.label, 'amz2023.') = 0,
                l.label,
                CONCAT(
                    substr(l.label, 1, strpos(l.label, 'amz2023.') - 1),
                    substr(
                        l.label,
                        length('amz2023.') + strpos(l.label, 'amz2023.')
                    )
                )
            ) as label,
            REGEXP_EXTRACT(j.name, '([^,]*),?', 1) as job_name,
            -- remove shard number and label from job names
            j.workflow_name,
            DATE_TRUNC(
                :granularity,
                PARSE_TIMESTAMP_ISO8601(j.started_at)
            ) AS bucket,
        FROM
            commons.workflow_job j
            CROSS JOIN UNNEST(j.labels as label) as l
        WHERE
            1 = 1
            AND j.labels is not NULL
            AND j._event_time > CURRENT_DATETIME() - DAYS(:days_ago)
            AND j.status = 'completed'
            AND l.label != 'self-hosted'
            AND l.label not like 'lf.c.%'
            AND l.label not like '%canary%'
    ),
    migrated_jobs AS (
        SELECT
            DISTINCT j.job_name
        FROM
            normalized_jobs j
        WHERE
            1 = 1
            AND j.label like 'lf%'
    ),
    comparable_jobs AS (
        SELECT
            j.bucket,
            j.label,
            j.job_name,
            -- remove shard number and label from job names
            j.workflow_name,
        FROM
            normalized_jobs j
            CROSS JOIN migrated_jobs mj
        WHERE
            1 = 1
            AND j.job_name = mj.job_name -- AND STRPOS(j.name, mj.job_clean) > 0
    ),
    success_stats AS (
        SELECT
            bucket,
            count(*) as group_size,
            job_name,
            workflow_name,
            label,
            IF(SUBSTR(label, 1, 3) = 'lf.', True, False) as lf_fleet,
        FROM
            comparable_jobs
        GROUP BY
            bucket,
            job_name,
            workflow_name,
            label
    ),
    comparison_stats AS (
        SELECT
            lf.bucket,
            SUM(lf.group_size + m.group_size) as total_jobs,
            SUM(m.group_size) as compliment_jobs,
            SUM(lf.group_size) as counted_jobs,
            m.lf_fleet as c_fleet,
            lf.lf_fleet as m_fleet,
            CAST(SUM(lf.group_size) as FLOAT) / SUM(lf.group_size + m.group_size) * 100 as percentage,
            IF(lf.lf_fleet, 'Linux Foundation', 'Meta') as fleet
        FROM
            success_stats lf
            INNER JOIN success_stats m on lf.bucket = m.bucket
        WHERE
            1 = 1
            AND lf.job_name = m.job_name
            AND lf.workflow_name = m.workflow_name
            AND (
                (
                    lf.lf_fleet = True
                    AND m.lf_fleet = False
                )
                OR (
                    lf.lf_fleet = False
                    AND m.lf_fleet = True
                )
            )
            AND lf.group_size > 3
            AND m.group_size > 3
        GROUP BY
            lf.bucket,
            lf.lf_fleet,
            m.lf_fleet
    )
SELECT
    *
from
    comparison_stats
ORDER BY
    bucket DESC
-- ORDER by bucket desc, job_name desc, success_rate_delta, workflow_name
