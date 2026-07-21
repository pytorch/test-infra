-- Powers the "pull workflow duration per trunk commit" KPI on https://hud.pytorch.org/kpis
-- Per trunk (main) commit of pytorch/pytorch, three duration treatments of the `pull`
-- workflow, each reported as weekly p50/p90 percentiles in HOURS:
--   wall-clock : workflow_run updated_at - created_at            (queue + run time)
--   longest_job: max(job completed_at - started_at)              (queue excluded)
--   build_test : max(build-job run) + max(test-job run)          (queue excluded)
WITH pull_runs AS (
    SELECT
        w.id AS run_id,
        w.created_at AS created_at,
        DATE_DIFF('second', w.created_at, w.updated_at) AS wallclock_sec
    FROM
        default.workflow_run w final
    WHERE
        lower(w.name) = 'pull'
        AND w.head_branch = 'main'
        AND w.head_repository.full_name = 'pytorch/pytorch'
        AND w.run_attempt = 1
        AND w.created_at >= {startTime: DateTime64(3)}
        AND w.created_at < {stopTime: DateTime64(3)}
        AND w.id IN (
            SELECT id
            FROM materialized_views.workflow_run_by_created_at
            WHERE created_at >= {startTime: DateTime64(3)}
                AND created_at < {stopTime: DateTime64(3)}
        )
),
per_run AS (
    SELECT
        any(r.created_at) AS created_at,
        any(r.wallclock_sec) / 3600.0 AS wallclock_hours,
        MAX(DATE_DIFF('second', j.started_at, j.completed_at)) / 3600.0 AS longest_job_hours,
        (
            MAX(IF(j.name LIKE '% / build%', DATE_DIFF('second', j.started_at, j.completed_at), 0))
            + MAX(IF(j.name LIKE '% / test%', DATE_DIFF('second', j.started_at, j.completed_at), 0))
        ) / 3600.0 AS build_test_hours
    FROM
        pull_runs r
        INNER JOIN default.workflow_job j final ON j.run_id = r.run_id
    WHERE
        toUnixTimestamp(j.completed_at) != 0
    GROUP BY
        r.run_id
),
weekly AS (
    SELECT
        toStartOfWeek(created_at, 0) AS bucket,
        quantileExact(0.5)(wallclock_hours) AS wallclock_p50,
        quantileExact(0.9)(wallclock_hours) AS wallclock_p90,
        quantileExact(0.5)(longest_job_hours) AS longest_job_p50,
        quantileExact(0.9)(longest_job_hours) AS longest_job_p90,
        quantileExact(0.5)(build_test_hours) AS build_test_p50,
        quantileExact(0.9)(build_test_hours) AS build_test_p90
    FROM
        per_run
    GROUP BY
        bucket
)
SELECT
    formatDateTime(bucket, '%Y-%m-%d') AS bucket,
    wallclock_p50,
    wallclock_p90,
    longest_job_p50,
    longest_job_p90,
    build_test_p50,
    build_test_p90
FROM
    weekly
WHERE
    bucket < CURRENT_TIMESTAMP() - INTERVAL 1 WEEK
ORDER BY
    bucket DESC
