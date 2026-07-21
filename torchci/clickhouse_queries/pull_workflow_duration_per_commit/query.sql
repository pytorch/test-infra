-- Powers the "pull workflow duration per trunk commit" KPI on https://hud.pytorch.org/kpis
-- Per trunk (main) commit of pytorch/pytorch, three duration treatments of the `pull`
-- workflow, each reported as weekly p50/p90 percentiles in HOURS:
--   wall-clock : workflow_run updated_at - created_at                       (queue + run time)
--   longest_job: max(job completed_at - started_at)                         (queue excluded)
--   build_test : per-config critical path = build run + that config's       (queue excluded)
--                longest test run, maxed across configs. Build and its
--                tests are chained by the job-name prefix before ' / '.
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
        r.run_id AS run_id,
        any(r.created_at) AS created_at,
        any(r.wallclock_sec) / 3600.0 AS wallclock_hours,
        MAX(DATE_DIFF('second', j.started_at, j.completed_at)) / 3600.0 AS longest_job_hours
    FROM
        pull_runs r
        INNER JOIN default.workflow_job j final ON j.run_id = r.run_id
    WHERE
        toUnixTimestamp(j.completed_at) != 0
    GROUP BY
        r.run_id
),
per_config AS (
    -- Chain build -> its tests by the job-name prefix before ' / '.
    -- maxIf returns 0 when a config has no build (or no test), so build-only
    -- and test-only configs degrade gracefully to whichever side exists.
    SELECT
        r.run_id AS run_id,
        splitByString(' / ', j.name)[1] AS config,
        maxIf(DATE_DIFF('second', j.started_at, j.completed_at), j.name LIKE '% / build%')
        + maxIf(DATE_DIFF('second', j.started_at, j.completed_at), j.name LIKE '% / test%') AS chain_sec
    FROM
        pull_runs r
        INNER JOIN default.workflow_job j final ON j.run_id = r.run_id
    WHERE
        toUnixTimestamp(j.completed_at) != 0
        AND (j.name LIKE '% / build%' OR j.name LIKE '% / test%')
    GROUP BY
        r.run_id,
        config
),
critical_path AS (
    SELECT
        run_id,
        MAX(chain_sec) / 3600.0 AS build_test_hours
    FROM
        per_config
    GROUP BY
        run_id
),
combined AS (
    SELECT
        pr.created_at AS created_at,
        pr.wallclock_hours AS wallclock_hours,
        pr.longest_job_hours AS longest_job_hours,
        cp.build_test_hours AS build_test_hours
    FROM
        per_run pr
        LEFT JOIN critical_path cp ON pr.run_id = cp.run_id
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
        combined
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
