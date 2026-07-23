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
        MAX(j.completed_at) AS max_completed,
        -- Conclusion of the longest build job and longest test job in this config,
        -- so we can surface whether a high build+test point was driven by a
        -- cancelled/failed job rather than a clean-but-slow run.
        argMaxIf(
            j.conclusion,
            DATE_DIFF('second', j.started_at, j.completed_at),
            j.name LIKE '% / build%'
        ) AS build_concl,
        argMaxIf(
            j.conclusion,
            DATE_DIFF('second', j.started_at, j.completed_at),
            j.name LIKE '% / test%'
        ) AS test_concl
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
        MAX(chain_sec) / 3600.0 AS build_test_hours,
        -- Conclusions of the config on the critical path (the one setting build_test_hours).
        argMax(build_concl, chain_sec) AS crit_build_concl,
        argMax(test_concl, chain_sec) AS crit_test_concl
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
        -- Worst conclusion among the critical config's longest build/test jobs.
        -- Failure-equivalents (failure/timed_out/startup_failure) collapse to 'failure';
        -- everything not explicitly cancelled/failed (incl. success and the empty
        -- conclusion of a config missing a build or test side) is 'success'.
        multiIf(
            crit_build_concl IN ('failure', 'timed_out', 'startup_failure')
            OR crit_test_concl IN ('failure', 'timed_out', 'startup_failure'), 'failure',
            crit_build_concl = 'cancelled' OR crit_test_concl = 'cancelled', 'cancelled',
            'success'
        ) AS crit_conclusion,
        quantileExact(0.5)(build_test_hours) OVER w AS baseline_median,
        quantileExact(0.9)(build_test_hours) OVER w AS baseline_p90,
        -- How many commits are in the trailing window; used to suppress flags on
        -- the first rows of the range where the baseline is not yet meaningful.
        count(build_test_hours) OVER w AS baseline_n
    FROM
        per_run
    WINDOW
        w AS (ORDER BY ts ASC ROWS BETWEEN 200 PRECEDING AND 1 PRECEDING)
),
-- Commit title + trunk land time from default.push (bloom-filter indexed on
-- head_commit.'id'), for cross-referencing flagged commits against what landed.
commit_meta AS (
    SELECT
        p.head_commit.'id' AS sha,
        splitByChar('\n', p.head_commit.'message')[1] AS commit_title,
        p.head_commit.'timestamp' AS land_time
    FROM default.push p
    WHERE
        p.repository.'full_name' = 'pytorch/pytorch'
        AND p.ref IN ('refs/heads/main', 'refs/heads/master')
        AND p.head_commit.'timestamp' >= {startTime: DateTime64(3)}
        AND p.head_commit.'timestamp' < {stopTime: DateTime64(3)}
    -- default.push is a ReplacingMergeTree read without FINAL, so a sha can have
    -- un-merged duplicate rows; keep one per sha so the join can't fan out points.
    LIMIT 1 BY sha
)
SELECT
    formatDateTime(s.ts, '%Y-%m-%dT%H:%i:%S') AS ts,
    s.sha AS sha,
    round(s.wallclock_hours, 3) AS wallclock_hours,
    round(s.longest_job_hours, 3) AS longest_job_hours,
    round(s.build_test_hours, 3) AS build_test_hours,
    round(s.baseline_median, 3) AS baseline_median,
    s.crit_conclusion AS crit_conclusion,
    (
        s.baseline_n >= 50
        AND s.baseline_median > 0
        AND s.build_test_hours > 1.10 * s.baseline_median
        AND s.build_test_hours > s.baseline_p90
    ) AS flagged,
    coalesce(m.commit_title, '') AS commit_title,
    if(
        toUnixTimestamp(m.land_time) = 0,
        '',
        formatDateTime(m.land_time, '%Y-%m-%dT%H:%i:%S')
    ) AS land_time
FROM
    scored s
LEFT JOIN commit_meta m ON m.sha = s.sha
ORDER BY
    s.ts ASC
