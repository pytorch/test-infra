-- noqa: disable=CP05,LT01
-- The health of every test in every environment and env var set it ran in
-- during the last 14 days: how often it ran and failed, when it last ran,
-- and the average duration of its passed attempts, each
-- over six windows and each for runs on main and for runs on pull requests.
-- Names say which runs and which window: _on_main counts jobs of pushes to
-- main, _on_pull_request jobs of pull_request events and of ciflow/* tag
-- pushes, which is how a pull request runs the trunk workflows; jobs on other
-- refs (nightly, release/*, workflow_dispatch, schedules) count in neither.
-- _1h, _12h, _1d, _3d, _7d and _14d take what started in the last 1 or 12
-- hours or 1, 3, 7 or 14 days before the refresh, so _14d is everything runs
-- keeps.
--
-- The unit is a run of the test, not an attempt. A row of runs is one
-- attempt, and CI retries a failing test in its process and then again in a
-- new process, so a test that breaks in one job leaves up to nine failed
-- attempts where a passing one leaves one. A run is a process that executed
-- the test, with the processes a failure caused to be retried folded into the
-- run they retry; a process that only skipped the test is not a run. runs
-- counts them and failed_runs those with a failed, error, crashed or timed_out
-- attempt, whether or not a retry then passed. A file that CI launches
-- several times in one job on purpose
-- (test_distributed_spawn once per backend, test_einops once per einops
-- version) counts once per launch. A failure rate is failed_runs over runs,
-- left to the reader: failed_runs_on_main_7d / nullIf(runs_on_main_7d, 0).
--
-- health is filled by health_mv, a refreshable materialized view: every 15
-- minutes it recomputes the whole table from runs and swaps the result in, so
-- readers get a complete table that is at most a refresh period old and never
-- scan runs themselves. On 2026-10-15, over two days of runs (400M rows), the
-- query took from 36 seconds to over 110 across runs, the spread being the
-- shared instance's load; it grows with the table. To run it now:
--   SYSTEM REFRESH VIEW health_mv; SYSTEM WAIT VIEW health_mv;
-- system.view_refreshes shows the last and next refresh and the last error,
-- and refreshed_at on every row says how old the data is. Join tests,
-- environments and env_vars (FINAL, as their schema requires) on the ids for
-- names. runs carries no branch, so the view reads each job's branch and
-- trigger from default.workflow_job and default.workflow_run.
CREATE TABLE health
(
    -- The test, environment and env var set, as runs.tests_id,
    -- runs.environments_id and runs.env_vars_id; one row per combination with
    -- an attempt, skipped included, on main or on a pull request in the last
    -- 14 days.
    tests_id                                      UInt64,
    environments_id                               UInt64,
    env_vars_id                                   UInt64,

    -- Mean of ended_at - started_at over the window's passed attempts, in
    -- milliseconds, rounded; NULL when no attempt passed in the window.
    avg_duration_milliseconds_on_main_1h          Nullable(UInt32),
    avg_duration_milliseconds_on_main_12h         Nullable(UInt32),
    avg_duration_milliseconds_on_main_1d          Nullable(UInt32),
    avg_duration_milliseconds_on_main_3d          Nullable(UInt32),
    avg_duration_milliseconds_on_main_7d          Nullable(UInt32),
    avg_duration_milliseconds_on_main_14d         Nullable(UInt32),
    avg_duration_milliseconds_on_pull_request_1h  Nullable(UInt32),
    avg_duration_milliseconds_on_pull_request_12h Nullable(UInt32),
    avg_duration_milliseconds_on_pull_request_1d  Nullable(UInt32),
    avg_duration_milliseconds_on_pull_request_3d  Nullable(UInt32),
    avg_duration_milliseconds_on_pull_request_7d  Nullable(UInt32),
    avg_duration_milliseconds_on_pull_request_14d Nullable(UInt32),

    -- Runs of the test in the window: processes that executed it (a process
    -- that only skipped it is not a run), with the processes a failure caused
    -- to be retried folded into the run they retry. The denominator of a
    -- failure rate: failed_runs_on_main_7d / nullIf(runs_on_main_7d, 0). A row
    -- whose runs are all 0 is a test collected here but skipped every time.
    runs_on_main_1h                               UInt32,
    runs_on_main_12h                              UInt32,
    runs_on_main_1d                               UInt32,
    runs_on_main_3d                               UInt32,
    runs_on_main_7d                               UInt32,
    runs_on_main_14d                              UInt32,
    runs_on_pull_request_1h                       UInt32,
    runs_on_pull_request_12h                      UInt32,
    runs_on_pull_request_1d                       UInt32,
    runs_on_pull_request_3d                       UInt32,
    runs_on_pull_request_7d                       UInt32,
    runs_on_pull_request_14d                      UInt32,

    -- Runs with a failed, error, crashed or timed_out attempt.
    failed_runs_on_main_1h                        UInt32,
    failed_runs_on_main_12h                       UInt32,
    failed_runs_on_main_1d                        UInt32,
    failed_runs_on_main_3d                        UInt32,
    failed_runs_on_main_7d                        UInt32,
    failed_runs_on_main_14d                       UInt32,
    failed_runs_on_pull_request_1h                UInt32,
    failed_runs_on_pull_request_12h               UInt32,
    failed_runs_on_pull_request_1d                UInt32,
    failed_runs_on_pull_request_3d                UInt32,
    failed_runs_on_pull_request_7d                UInt32,
    failed_runs_on_pull_request_14d               UInt32,

    -- Start of the newest executed attempt, on either kind of job and per
    -- kind; NULL when there is none.
    last_run_at                                   Nullable(DateTime64(3, 'UTC')),
    last_run_at_on_main                           Nullable(DateTime64(3, 'UTC')),
    last_run_at_on_pull_request                   Nullable(DateTime64(3, 'UTC')),

    -- When the refresh that wrote this row started: the age of the data.
    refreshed_at                                  DateTime('UTC')
)
ENGINE = MergeTree
ORDER BY (tests_id, environments_id, env_vars_id);

CREATE MATERIALIZED VIEW health_mv
REFRESH EVERY 15 MINUTE
TO health
AS
WITH
    -- The jobs that started in the last 15 days, a day more than runs keeps so
    -- that no run's job is missed, with their trigger: 1 for a push to main, 2
    -- for a pull request, 0 for anything else. workflow_job and workflow_run
    -- may hold a row twice (ReplacingMergeTree): an IN set does not mind, and
    -- ANY LEFT JOIN takes one run row per job.
    jobs AS (
        SELECT
            j.id AS id,
            multiIf(
                j.head_branch = 'main' AND w.event = 'push', 1,
                w.event = 'pull_request' OR startsWith(j.head_branch, 'ciflow/'), 2,
                0
            ) AS kind
        FROM (
            SELECT id, run_id, head_branch
            FROM default.workflow_job
            WHERE started_at >= now() - INTERVAL 15 DAY
        ) AS j
        ANY LEFT JOIN (
            SELECT id, event
            FROM default.workflow_run
            WHERE id IN (
                SELECT run_id
                FROM default.workflow_job
                WHERE started_at >= now() - INTERVAL 15 DAY
            )
        ) AS w ON w.id = j.run_id
        WHERE kind != 0
    ),
    -- The tests with a failed attempt in the window: a few hundred, so the
    -- pass that folds retries reads only their rows, pruned by tests_id, the
    -- leading sort key of runs.
    failing_tests AS (
        SELECT DISTINCT tests_id
        FROM runs
        WHERE started_at >= now() - INTERVAL 14 DAY
          AND outcome IN ('failed', 'error', 'crashed', 'timed_out')
    )
-- Two passes over runs. attempts is the cheap one: every attempt of the
-- window, counting executed first attempts (rerun_number 0, one per process)
-- and passed durations. failures is the small one: the failing tests' attempts
-- grouped into processes (one report per process) and then into (test,
-- environment, env vars, job) pairs, where a process that follows a process
-- which ended failing is a retry and not a new run. runs is then the first
-- attempts minus those retries.
-- Windows: each attempt (or failing pair) falls in one bucket, the smallest
-- window that holds it, numbered 1 = last hour, 2 = last 12 hours, 3 = last
-- day, 4 = 3 days, 5 = 7 days, 6 = the rest of the 14 days. The -Resample
-- combinator counts the six buckets in one aggregate and arrayCumSum turns
-- them into the windows, so element i of every array below is window i.
SELECT
    attempts.tests_id AS tests_id,
    attempts.environments_id AS environments_id,
    attempts.env_vars_id AS env_vars_id,
    -- a division by a NULL (no passed attempt) is NULL, and accurateCastOrNull
    -- keeps it so
    accurateCastOrNull(round(attempts.passed_ms_main[1] / nullIf(attempts.passed_main[1], 0)), 'UInt32')
        AS avg_duration_milliseconds_on_main_1h,
    accurateCastOrNull(round(attempts.passed_ms_main[2] / nullIf(attempts.passed_main[2], 0)), 'UInt32')
        AS avg_duration_milliseconds_on_main_12h,
    accurateCastOrNull(round(attempts.passed_ms_main[3] / nullIf(attempts.passed_main[3], 0)), 'UInt32')
        AS avg_duration_milliseconds_on_main_1d,
    accurateCastOrNull(round(attempts.passed_ms_main[4] / nullIf(attempts.passed_main[4], 0)), 'UInt32')
        AS avg_duration_milliseconds_on_main_3d,
    accurateCastOrNull(round(attempts.passed_ms_main[5] / nullIf(attempts.passed_main[5], 0)), 'UInt32')
        AS avg_duration_milliseconds_on_main_7d,
    accurateCastOrNull(round(attempts.passed_ms_main[6] / nullIf(attempts.passed_main[6], 0)), 'UInt32')
        AS avg_duration_milliseconds_on_main_14d,
    accurateCastOrNull(round(attempts.passed_ms_pull_request[1] / nullIf(attempts.passed_pull_request[1], 0)), 'UInt32')
        AS avg_duration_milliseconds_on_pull_request_1h,
    accurateCastOrNull(round(attempts.passed_ms_pull_request[2] / nullIf(attempts.passed_pull_request[2], 0)), 'UInt32')
        AS avg_duration_milliseconds_on_pull_request_12h,
    accurateCastOrNull(round(attempts.passed_ms_pull_request[3] / nullIf(attempts.passed_pull_request[3], 0)), 'UInt32')
        AS avg_duration_milliseconds_on_pull_request_1d,
    accurateCastOrNull(round(attempts.passed_ms_pull_request[4] / nullIf(attempts.passed_pull_request[4], 0)), 'UInt32')
        AS avg_duration_milliseconds_on_pull_request_3d,
    accurateCastOrNull(round(attempts.passed_ms_pull_request[5] / nullIf(attempts.passed_pull_request[5], 0)), 'UInt32')
        AS avg_duration_milliseconds_on_pull_request_7d,
    accurateCastOrNull(round(attempts.passed_ms_pull_request[6] / nullIf(attempts.passed_pull_request[6], 0)), 'UInt32')
        AS avg_duration_milliseconds_on_pull_request_14d,
    toUInt32(greatest(attempts.first_runs_main[1] - failures.extra_main[1], 0))
        AS runs_on_main_1h,
    toUInt32(greatest(attempts.first_runs_main[2] - failures.extra_main[2], 0))
        AS runs_on_main_12h,
    toUInt32(greatest(attempts.first_runs_main[3] - failures.extra_main[3], 0))
        AS runs_on_main_1d,
    toUInt32(greatest(attempts.first_runs_main[4] - failures.extra_main[4], 0))
        AS runs_on_main_3d,
    toUInt32(greatest(attempts.first_runs_main[5] - failures.extra_main[5], 0))
        AS runs_on_main_7d,
    toUInt32(greatest(attempts.first_runs_main[6] - failures.extra_main[6], 0))
        AS runs_on_main_14d,
    toUInt32(greatest(attempts.first_runs_pull_request[1] - failures.extra_pull_request[1], 0))
        AS runs_on_pull_request_1h,
    toUInt32(greatest(attempts.first_runs_pull_request[2] - failures.extra_pull_request[2], 0))
        AS runs_on_pull_request_12h,
    toUInt32(greatest(attempts.first_runs_pull_request[3] - failures.extra_pull_request[3], 0))
        AS runs_on_pull_request_1d,
    toUInt32(greatest(attempts.first_runs_pull_request[4] - failures.extra_pull_request[4], 0))
        AS runs_on_pull_request_3d,
    toUInt32(greatest(attempts.first_runs_pull_request[5] - failures.extra_pull_request[5], 0))
        AS runs_on_pull_request_7d,
    toUInt32(greatest(attempts.first_runs_pull_request[6] - failures.extra_pull_request[6], 0))
        AS runs_on_pull_request_14d,
    toUInt32(failures.failed_main[1])
        AS failed_runs_on_main_1h,
    toUInt32(failures.failed_main[2])
        AS failed_runs_on_main_12h,
    toUInt32(failures.failed_main[3])
        AS failed_runs_on_main_1d,
    toUInt32(failures.failed_main[4])
        AS failed_runs_on_main_3d,
    toUInt32(failures.failed_main[5])
        AS failed_runs_on_main_7d,
    toUInt32(failures.failed_main[6])
        AS failed_runs_on_main_14d,
    toUInt32(failures.failed_pull_request[1])
        AS failed_runs_on_pull_request_1h,
    toUInt32(failures.failed_pull_request[2])
        AS failed_runs_on_pull_request_12h,
    toUInt32(failures.failed_pull_request[3])
        AS failed_runs_on_pull_request_1d,
    toUInt32(failures.failed_pull_request[4])
        AS failed_runs_on_pull_request_3d,
    toUInt32(failures.failed_pull_request[5])
        AS failed_runs_on_pull_request_7d,
    toUInt32(failures.failed_pull_request[6])
        AS failed_runs_on_pull_request_14d,
    attempts.last_run_at AS last_run_at,
    attempts.last_run_at_on_main AS last_run_at_on_main,
    attempts.last_run_at_on_pull_request AS last_run_at_on_pull_request,
    now('UTC') AS refreshed_at
FROM
(
    SELECT
        tests_id,
        environments_id,
        env_vars_id,
        arrayCumSum(sumIfResample(1, 7, 1)(duration_ms, passed AND on_main, window)) AS passed_ms_main,
        arrayCumSum(countIfResample(1, 7, 1)(passed AND on_main, window)) AS passed_main,
        arrayCumSum(countIfResample(1, 7, 1)(first AND executed AND on_main, window)) AS first_runs_main,
        arrayCumSum(sumIfResample(1, 7, 1)(duration_ms, passed AND on_pull_request, window)) AS passed_ms_pull_request,
        arrayCumSum(countIfResample(1, 7, 1)(passed AND on_pull_request, window)) AS passed_pull_request,
        arrayCumSum(countIfResample(1, 7, 1)(first AND executed AND on_pull_request, window)) AS first_runs_pull_request,
        maxIfOrNull(started_at, executed) AS last_run_at,
        maxIfOrNull(started_at, executed AND on_main) AS last_run_at_on_main,
        maxIfOrNull(started_at, executed AND on_pull_request) AS last_run_at_on_pull_request
    FROM
    (
        SELECT
            tests_id,
            environments_id,
            env_vars_id,
            started_at,
            github_workflow_job_id IN (SELECT id FROM jobs WHERE kind = 1) AS on_main,
            github_workflow_job_id IN (SELECT id FROM jobs WHERE kind = 2) AS on_pull_request,
            rerun_number = 0 AS first,
            outcome != 'skipped' AS executed,
            outcome = 'passed' AS passed,
            dateDiff('second', started_at, now()) AS age,
            multiIf(age < 3600, 1, age < 43200, 2, age < 86400, 3, age < 259200, 4, age < 604800, 5, 6) AS window,
            -- never negative, should a clock have gone backwards between the stamps
            greatest(0, dateDiff('millisecond', started_at, ended_at)) AS duration_ms
        FROM runs
        WHERE started_at >= now() - INTERVAL 14 DAY
          AND (on_main OR on_pull_request)
    )
    GROUP BY tests_id, environments_id, env_vars_id
) AS attempts
LEFT JOIN
(
    SELECT
        tests_id,
        environments_id,
        env_vars_id,
        arrayCumSum(countIfResample(1, 7, 1)(on_main, window)) AS failed_main,
        arrayCumSum(sumIfResample(1, 7, 1)(processes - runs, on_main, window)) AS extra_main,
        arrayCumSum(countIfResample(1, 7, 1)(on_pull_request, window)) AS failed_pull_request,
        arrayCumSum(sumIfResample(1, 7, 1)(processes - runs, on_pull_request, window)) AS extra_pull_request
    FROM
    (
        -- one row per (test, environment, env vars, job) pair with a failure
        SELECT
            tests_id,
            environments_id,
            env_vars_id,
            github_workflow_job_id,
            github_workflow_job_id IN (SELECT id FROM jobs WHERE kind = 1) AS on_main,
            github_workflow_job_id IN (SELECT id FROM jobs WHERE kind = 2) AS on_pull_request,
            min(process_started_at) AS job_started_at,
            dateDiff('second', job_started_at, now()) AS age,
            multiIf(age < 3600, 1, age < 43200, 2, age < 86400, 3, age < 259200, 4, age < 604800, 5, 6) AS window,
            countIf(executed) AS processes,
            -- the executing processes in time order, each with whether it
            -- ended failing; a process after one that ended failing is a retry
            arraySort(x -> x.1, groupArrayIf((process_started_at, ended_failing), executed)) AS procs,
            arrayCount(i -> i = 1 OR NOT procs[i - 1].2, arrayEnumerate(procs)) AS runs,
            max(failed) AS failed
        FROM
        (
            -- one row per process: the attempts of a test that share a report
            SELECT
                tests_id,
                environments_id,
                env_vars_id,
                github_workflow_job_id,
                report_uuid,
                min(started_at) AS process_started_at,
                max(outcome != 'skipped') AS executed,
                max(outcome IN ('failed', 'error', 'crashed', 'timed_out')) AS failed,
                max(outcome = 'passed') AS passed,
                failed AND NOT passed AS ended_failing
            FROM runs
            WHERE tests_id IN failing_tests
              AND started_at >= now() - INTERVAL 14 DAY
            GROUP BY tests_id, environments_id, env_vars_id, github_workflow_job_id, report_uuid
        )
        WHERE on_main OR on_pull_request
        GROUP BY tests_id, environments_id, env_vars_id, github_workflow_job_id
        HAVING failed
    )
    GROUP BY tests_id, environments_id, env_vars_id
) AS failures
    ON failures.tests_id = attempts.tests_id
    AND failures.environments_id = attempts.environments_id
    AND failures.env_vars_id = attempts.env_vars_id;
