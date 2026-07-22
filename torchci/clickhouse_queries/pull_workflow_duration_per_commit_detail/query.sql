-- Powers the per-commit drill-down on the "pull workflow duration per trunk commit"
-- KPI at https://hud.pytorch.org/kpis. One row per trunk (main) commit's `pull`
-- workflow run, with the three duration treatments (hours) and an anomaly flag.
--   flagged = the build+test critical path is BOTH >10% over the trailing
--             rolling-median baseline AND above the trailing p90 (a spread gate,
--             so single-commit noise near the median is not flagged).
-- Reads default.workflow_job directly (embedded workflow_* columns), no join to
-- workflow_run and no FINAL: every per-run aggregate is min/max/maxIf (duplicate-safe)
-- and completed_at != 0 drops in-progress duplicate rows. Duration definitions match
-- the weekly pull_workflow_duration_per_commit query.
WITH per_config AS (
    SELECT
        j.run_id AS run_id,
        any(j.head_sha) AS head_sha,
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
        -- Drop data-quality artifacts: GitHub marks stuck jobs "completed" up to
        -- 30 days later (~720h), which otherwise dominates the max/span aggregates.
        AND DATE_DIFF('second', j.started_at, j.completed_at) < 86400
    GROUP BY
        j.run_id,
        wf_created,
        config
),
per_run AS (
    SELECT
        any(head_sha) AS sha,
        any(wf_created) AS ts,
        DATE_DIFF('second', MIN(min_started), MAX(max_completed)) / 3600.0 AS wallclock_hours,
        MAX(max_job_sec) / 3600.0 AS longest_job_hours,
        MAX(chain_sec) / 3600.0 AS build_test_hours
    FROM
        per_config
    GROUP BY
        run_id
),
scored AS (
    -- Trailing rolling baseline over the previous 200 commits (excludes the current row).
    SELECT
        ts,
        sha,
        wallclock_hours,
        longest_job_hours,
        build_test_hours,
        quantileExact(0.5)(build_test_hours) OVER w AS baseline_median,
        quantileExact(0.9)(build_test_hours) OVER w AS baseline_p90
    FROM
        per_run
    WINDOW
        w AS (ORDER BY ts ASC ROWS BETWEEN 200 PRECEDING AND 1 PRECEDING)
)
SELECT
    formatDateTime(ts, '%Y-%m-%dT%H:%i:%S') AS ts,
    sha,
    round(wallclock_hours, 3) AS wallclock_hours,
    round(longest_job_hours, 3) AS longest_job_hours,
    round(build_test_hours, 3) AS build_test_hours,
    round(baseline_median, 3) AS baseline_median,
    (
        baseline_median > 0
        AND build_test_hours > 1.10 * baseline_median
        AND build_test_hours > baseline_p90
    ) AS flagged
FROM
    scored
ORDER BY
    ts ASC
