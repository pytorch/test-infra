-- Per-commit individual-test breakdown for a single viable/strict commit,
-- aggregated per test (name/classname/file) across the commit's strict-blocking
-- jobs. Server-side paginated and filterable by state so we never scan or
-- serialize the whole (millions-of-rows) all_test_runs result at once.
--
-- Powers the per-run page at /viablestrict/[sha].
--
-- Perf notes:
--   * We derive a tight time window from the jobs' started_at and filter
--     all_test_runs by time_inserted so ClickHouse can prune partitions instead
--     of scanning the whole (very large) table.
--   * State filter + LIMIT/OFFSET keep the payload small; count() OVER ()
--     returns the full filtered count for the pager.
--
-- Matching GitHub's final state. Two retry mechanisms both have to read as
-- "passed":
--   1. Whole-job re-run -> a later workflow_run_attempt. We keep only the latest
--      attempt per (test, config).
--   2. "failed and then succeeded when run in a new process" -> the failed run
--      and the passing retry are SEPARATE rows in all_test_runs with the SAME
--      attempt. So within a config we look at whether there is any PASSING row,
--      not just whether any row failed: fail+pass => flaky (recovered, green);
--      fail with no pass => genuinely failed (red).
WITH tests_jobs AS (
    SELECT
        j.id AS job_id,
        j.run_id AS workflow_id,
        j.workflow_name AS workflow_name,
        j.name AS job_name,
        j.run_attempt AS run_attempt,
        j.conclusion_kg AS conclusion,
        j.started_at AS started_at
    FROM
        default.workflow_job j FINAL
    WHERE
        j.id IN (
            SELECT id FROM materialized_views.workflow_job_by_head_sha
            WHERE head_sha = {sha: String}
        )
        -- Only the canonical on-main evaluation of the commit: drops PR/draft
        -- runs, trunk/{sha} ciflow-tag duplicates, landchecks, and dispatch
        -- restarts that share the SHA but aren't the main-branch signal.
        AND j.head_branch = 'main'
        -- Restrict to the strict-blocking workflows (mirror update-viablestrict.yml)
        AND j.workflow_name IN {workflows: Array(String)}
        -- Exclude jobs that never gate viable/strict
        AND j.name NOT LIKE '%mem_leak_check%'
        AND j.name NOT LIKE '%rerun_disabled_tests%'
        AND j.name NOT LIKE '%unstable%'
),
job_conclusions AS (
    -- Final (latest-attempt) conclusion per job. A test only counts as a real
    -- "failed" if its job actually ended red -- mirrors the gate, and means a
    -- failing test in a green job (e.g. a non-fatal XPASS, or a job re-run
    -- green) reads as non-blocking instead of failed.
    SELECT
        workflow_name,
        job_name,
        argMax(conclusion, run_attempt) AS job_conclusion
    FROM tests_jobs
    GROUP BY workflow_name, job_name
),
bounds AS (
    SELECT
        min(started_at) - INTERVAL 1 DAY AS lo,
        max(started_at) + INTERVAL 2 DAY AS hi
    FROM tests_jobs
),
test_rows AS (
    SELECT
        t.invoking_file AS invoking_file,
        t.file AS file,
        t.classname AS classname,
        t.name AS name,
        j.workflow_name AS workflow_name,
        j.job_name AS job_name,
        t.workflow_run_attempt AS run_attempt,
        t.time AS time,
        length(t.failure) AS failure_count,
        length(t.error) AS error_count,
        length(t.skipped) AS skipped_count,
        length(t.rerun) AS rerun_count,
        -- Failure excerpt for the Details column (only failures populate this;
        -- out-of-range array access returns '' in ClickHouse, so this is safe).
        if(t.failure[1].'text' != '', t.failure[1].'text', t.error[1].'text') AS failure_text
    FROM
        tests.all_test_runs t
        INNER JOIN tests_jobs j ON t.job_id = j.job_id
    WHERE
        t.workflow_id IN (SELECT workflow_id FROM tests_jobs)
        AND t.time_inserted BETWEEN (SELECT lo FROM bounds) AND (SELECT hi FROM bounds)
),
-- Keep only the latest workflow_run_attempt's rows per (test, config), so a
-- whole-job re-run supersedes the earlier attempt.
test_rows_latest AS (
    SELECT
        *,
        max(run_attempt) OVER (
            PARTITION BY invoking_file, file, classname, name, workflow_name, job_name
        ) AS max_attempt
    FROM test_rows
),
per_config AS (
    SELECT
        invoking_file,
        file,
        classname,
        name,
        workflow_name,
        job_name,
        SUM(time) AS time,
        SUM(failure_count) AS failures,
        SUM(error_count) AS errors,
        SUM(rerun_count) AS config_reruns,
        -- A failing execution and a passing execution of the same test (the
        -- "succeeded in a new process" case) both appear here as separate rows.
        countIf(failure_count + error_count > 0) AS fail_rows,
        countIf(failure_count + error_count = 0 AND skipped_count = 0) AS pass_rows,
        countIf(skipped_count > 0) AS skip_rows,
        anyIf(failure_text, failure_text != '') AS details
    FROM test_rows_latest
    WHERE run_attempt = max_attempt
    GROUP BY
        invoking_file,
        file,
        classname,
        name,
        workflow_name,
        job_name
),
durations AS (
    -- Per-execution duration stats per test (median/p90 over individual runs;
    -- approximate quantiles -- sketch-based, cheap over already-scanned rows).
    SELECT
        invoking_file,
        file,
        classname,
        name,
        median(time) AS median_time,
        quantile(0.9)(time) AS p90_time
    FROM test_rows_latest
    WHERE run_attempt = max_attempt
    GROUP BY invoking_file, file, classname, name
),
agg AS (
    SELECT
        pc.invoking_file AS invoking_file,
        pc.file AS file,
        pc.classname AS classname,
        pc.name AS name,
        count(*) AS runs,
        SUM(pc.time) AS time,
        any(d.median_time) AS median_time,
        any(d.p90_time) AS p90_time,
        SUM(pc.failures) AS failures,
        SUM(pc.errors) AS errors,
        SUM(pc.skip_rows) AS skipped,
        SUM(pc.config_reruns) AS reruns,
        -- Full GitHub job identifier ("pull / linux-... / test-osdc (default)"),
        -- with the matrix suffix collapsed from "(config, shard, total, runner)"
        -- to just "(config)" -- keeps the meaningful config, drops shard indices
        -- and the runner label.
        groupUniqArray(
            concat(
                pc.workflow_name, ' / ',
                replaceRegexpOne(pc.job_name, '\\(([^,)]+)[^)]*\\)', '(\\1)')
            )
        ) AS jobs,
        anyIf(pc.details, pc.details != '') AS details,
        -- Configs where the test failed, never passed, AND the job ended red.
        groupUniqArrayIf(
            concat(
                pc.workflow_name, ' / ',
                replaceRegexpOne(pc.job_name, '\\(([^,)]+)[^)]*\\)', '(\\1)')
            ),
            pc.fail_rows > 0 AND pc.pass_rows = 0
                AND jc.job_conclusion NOT IN ('success', 'skipped', '')
        ) AS failed_jobs,
        -- "failed"  = a config failed with no passing run AND its job ended red
        --             (i.e. it actually blocked -- matches GitHub).
        -- "flaky"   = failed somewhere but did NOT block: recovered on retry /
        --             in a new process, in-process reruns, or a non-fatal
        --             failure (e.g. XPASS) in a job that stayed green.
        -- "skipped" = every config only skipped.
        multiIf(
            countIf(
                pc.fail_rows > 0 AND pc.pass_rows = 0
                    AND jc.job_conclusion NOT IN ('success', 'skipped', '')
            ) > 0, 'failed',
            countIf(pc.fail_rows > 0) > 0 OR SUM(pc.config_reruns) > 0, 'flaky',
            countIf(pc.skip_rows > 0 AND pc.pass_rows = 0) = count(*), 'skipped',
            'success'
        ) AS conclusion
    FROM
        per_config pc
        LEFT JOIN job_conclusions jc
            ON pc.workflow_name = jc.workflow_name AND pc.job_name = jc.job_name
        LEFT JOIN durations d
            ON pc.invoking_file = d.invoking_file
            AND pc.file = d.file
            AND pc.classname = d.classname
            AND pc.name = d.name
    GROUP BY
        pc.invoking_file,
        pc.file,
        pc.classname,
        pc.name
)
SELECT
    invoking_file,
    file,
    classname,
    name,
    runs,
    time,
    median_time,
    p90_time,
    failures,
    errors,
    skipped,
    reruns,
    jobs,
    failed_jobs,
    details,
    conclusion,
    total_count
FROM (
    SELECT
        *,
        count() OVER () AS total_count
    FROM
        agg
    WHERE
        -- {states} is a list of conclusions to show; ['all'] shows everything.
        (has({states: Array(String)}, 'all') OR has({states: Array(String)}, conclusion))
        AND name LIKE {name_filter: String}
)
ORDER BY
    -- Failed first, then skipped, then flaky, then success (mockup order).
    multiIf(conclusion = 'failed', 0, conclusion = 'skipped', 1, conclusion = 'flaky', 2, 3) ASC,
    -- {sort} = 'name' sorts by test name asc; anything else by duration desc.
    if({sort: String} = 'name', name, '') ASC,
    if({sort: String} = 'name', 0, time) DESC
LIMIT {limit: Int64} OFFSET {offset: Int64}
