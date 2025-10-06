WITH prs AS (
    SELECT
        number,
        state,
        merged,
        merged_by,
        auto_merge,
        updated_at,
        formatDateTime(
            DATE_TRUNC(
                {granularity: String },
                parseDateTimeBestEffort(updated_at)
            ),
            '%Y-%m-%d'
        ) AS bucket
    FROM
        pull_request
    WHERE
        dynamoKey like concat({repo: String }, '%')
        AND parseDateTimeBestEffort(updated_at) >= {startTime: DateTime64(3) }
        AND parseDateTimeBestEffort(updated_at) < {stopTime: DateTime64(3) }
),
total_prs AS (
    SELECT
        bucket,
        count(number) AS total_count
    FROM
        prs
    GROUP BY
        bucket
),
open_prs AS (
    SELECT
        bucket,
        count(number) AS open_count
    FROM
        prs
    WHERE
        state = 'open'
    GROUP BY
        bucket
),
abandon_prs AS (
    SELECT
        bucket,
        count(number) AS abandon_count
    FROM
        prs
    WHERE
        state = 'closed'
        AND merged = 'false'
    GROUP BY
        bucket
),
merged_prs AS (
    SELECT
        *
    FROM
        prs
    WHERE
        state = 'closed'
        AND merged = 'true'
),
buildkite_jobs AS (
    SELECT
        tupleElement(vllm.vllm_buildkite_jobs.build, 'pull_request').id AS number,
        tupleElement(vllm.vllm_buildkite_jobs.job, 'name') AS job_name,
        tupleElement(vllm.vllm_buildkite_jobs.job, 'state') AS job_state,
        tupleElement(vllm.vllm_buildkite_jobs.job, 'created_at') AS job_created_at,
        -- Row 1 is the latest run of the job
        ROW_NUMBER() OVER (
            PARTITION BY number,
            job_name
            ORDER BY
                job_created_at DESC
        ) AS row_num
    FROM
        vllm.vllm_buildkite_jobs
    WHERE
        tupleElement(vllm.vllm_buildkite_jobs.build, 'pull_request').id IN (
            SELECT
                toString(number)
            FROM
                merged_prs
        )
        -- Don't care for soft_failed jobs
        AND tupleElement(vllm.vllm_buildkite_jobs.job, 'soft_failed') = 'false'
),
latest_buildkite_jobs AS (
    SELECT
        *
    FROM
        buildkite_jobs
    WHERE
        row_num = 1
),
manual_merged_prs AS (
    SELECT
        bucket,
        count(number) AS manual_merged_count
    FROM
        merged_prs
    WHERE
        tupleElement(auto_merge, 'merge_method') = ''
    GROUP BY
        bucket
),
manual_merged_prs_with_failures AS (
    SELECT
        bucket,
        count(DISTINCT number) AS manual_merged_with_failures_count
    FROM
        merged_prs
        LEFT JOIN latest_buildkite_jobs ON toString(merged_prs.number) = latest_buildkite_jobs.number
    WHERE
        tupleElement(auto_merge, 'merge_method') = ''
        AND job_state = 'failed'
    GROUP BY
        bucket
),
manual_merged_prs_pending AS (
    SELECT
        bucket,
        count(DISTINCT number) AS manual_merged_pending_count
    FROM
        merged_prs
        LEFT JOIN latest_buildkite_jobs ON toString(merged_prs.number) = latest_buildkite_jobs.number
    WHERE
        tupleElement(auto_merge, 'merge_method') = ''
        AND job_state IN ('running', 'pending', 'scheduled')
    GROUP BY
        bucket
),
auto_merged_prs AS (
    SELECT
        bucket,
        count(number) AS auto_merged_count
    FROM
        merged_prs
    WHERE
        tupleElement(auto_merge, 'merge_method') != ''
    GROUP BY
        bucket
),
results AS (
    SELECT
        total_prs.bucket AS granularity_bucket,
        total_count,
        open_count,
        abandon_count,
        auto_merged_count,
        manual_merged_count,
        manual_merged_with_failures_count,
        manual_merged_pending_count
    FROM
        total_prs
        LEFT JOIN open_prs ON total_prs.bucket = open_prs.bucket
        LEFT JOIN abandon_prs ON total_prs.bucket = abandon_prs.bucket
        LEFT JOIN auto_merged_prs ON total_prs.bucket = auto_merged_prs.bucket
        LEFT JOIN manual_merged_prs ON total_prs.bucket = manual_merged_prs.bucket
        LEFT JOIN manual_merged_prs_with_failures ON total_prs.bucket = manual_merged_prs_with_failures.bucket
        LEFT JOIN manual_merged_prs_pending ON total_prs.bucket = manual_merged_prs_pending.bucket
)
SELECT
    *
FROM
    results
ORDER BY
    granularity_bucket ASC
