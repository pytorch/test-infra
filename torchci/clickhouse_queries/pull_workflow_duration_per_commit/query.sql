-- Powers the "pull workflow duration per trunk commit" KPI on https://hud.pytorch.org/kpis
-- Per trunk (main) commit of pytorch/pytorch, three duration treatments of the `pull`
-- workflow, each reported as weekly p50/p90 percentiles in HOURS:
--   wall-clock : first job start -> last job completion (~ workflow_run created->updated; queue + run)
--   longest_job: max(job completed_at - started_at)                                     (queue excluded)
--   build_test : per-config critical path = build run + that config's longest test run, (queue excluded)
--                maxed across configs. Build and its tests are chained by the job-name
--                prefix before ' / '.
--
-- Reads default.workflow_job directly via its embedded workflow_name/head_branch/
-- repository_full_name/workflow_created_at columns (no join to workflow_run), and avoids
-- FINAL: every per-run aggregate is min/max/maxIf, which is duplicate-safe, and the
-- completed_at != 0 filter drops in-progress duplicate rows. ~2x faster than the join+FINAL form.
WITH per_config AS (
    -- Chain build -> its tests by the job-name prefix before ' / '.
    -- maxIf returns 0 when a config has no build (or no test), so build-only
    -- and test-only configs degrade gracefully to whichever side exists.
    SELECT
        j.run_id AS run_id,
        j.workflow_created_at AS wf_created,
        splitByString(' / ', j.name)[1] AS config,
        maxIf(DATE_DIFF('second', j.started_at, j.completed_at), j.name LIKE '% / build%')
        + maxIf(DATE_DIFF('second', j.started_at, j.completed_at), j.name LIKE '% / test%') AS chain_sec,
        MAX(DATE_DIFF('second', j.started_at, j.completed_at)) AS max_job_sec,
        MIN(j.started_at) AS min_started,
        MAX(j.completed_at) AS max_completed
    FROM
        default.workflow_job j
    WHERE
        j.workflow_name = 'pull'
        AND j.head_branch = 'main'
        AND j.repository_full_name = 'pytorch/pytorch'
        AND j.run_attempt = 1
        AND j.workflow_created_at >= {startTime: DateTime64(3)}
        AND j.workflow_created_at < {stopTime: DateTime64(3)}
        AND toUnixTimestamp(j.completed_at) != 0
    GROUP BY
        j.run_id,
        wf_created,
        config
),
per_run AS (
    SELECT
        run_id,
        any(wf_created) AS wf_created,
        DATE_DIFF('second', MIN(min_started), MAX(max_completed)) / 3600.0 AS wallclock_hours,
        MAX(max_job_sec) / 3600.0 AS longest_job_hours,
        MAX(chain_sec) / 3600.0 AS build_test_hours
    FROM
        per_config
    GROUP BY
        run_id
),
weekly AS (
    SELECT
        toStartOfWeek(wf_created, 0) AS bucket,
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
    -- Drop the latest partial week. Filter here (on the Date `bucket`) rather than
    -- in the outer query, where `bucket` is re-aliased to a formatDateTime String and
    -- `String < DateTime` throws NO_COMMON_TYPE (Code 386).
    HAVING
        bucket < CURRENT_TIMESTAMP() - INTERVAL 1 WEEK
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
ORDER BY
    bucket DESC
