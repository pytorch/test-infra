-- noqa: disable=CP05,LT01
-- Test health by environment, env vars, code source and rolling window.
-- A run is a first execution plus retries after failure, within a report or
-- in subsequent reports of the same job. Intentional repeated passes remain
-- separate runs. Skips are counted separately. Failed runs include recoveries;
-- flaky runs are failed runs whose final attempt passed. Only clean first
-- passes contribute to the passed duration; the mean and total durations
-- count every executed attempt. Counts and the passed duration belong to the
-- run's first start time; attempts, the other durations, last_run_at and
-- last_failed_at include retries in each window at their own start time.
-- A chain continues only after a terminal failure; a skip or expected outcome
-- ends it. Cross-process retries are inferred: runs has no retry-parent id.
--
-- Main includes push/schedule jobs on main. Pull requests include pull_request
-- events and pushes to ciflow/* tags. rerun_disabled_tests jobs are excluded.
-- Other triggers do not contribute. Source ingestion can lag execution by
-- hours; each refresh atomically replaces all windows. Attempts after the
-- refresh start are excluded, even if a source clock is ahead.
-- Read catalog names with FINAL when joining tests, environments and env_vars.
--
-- FINAL removes duplicate inserted attempts before counting. Missing report
-- UUIDs share one process per job. Processes lacking a first attempt inside
-- the retained 14 days do not create a run. Cross-process retries whose first
-- failed process has aged out are treated as new runs.
CREATE TABLE health
(
    -- Formulas below apply to one (test, environment, env vars, ran_on, window)
    -- group. A run includes its retries; an attempt is one row of runs FINAL.
    -- other_runs and unrecovered_runs below are explanations, not columns.

    -- tests_id = runs.tests_id; identifies tests.id and groups that test's runs.
    tests_id                     UInt64,
    -- environments_id = runs.environments_id; groups by environments.id.
    environments_id              UInt64,
    -- env_vars_id = runs.env_vars_id; groups by env_vars.id.
    env_vars_id                  UInt64,

    -- ran_on = 'main' when head_branch = 'main' AND event IN ('push', 'schedule');
    -- otherwise 'pull_request' when event = 'pull_request' OR
    -- (event = 'push' AND head_branch starts with 'ciflow/'). Other jobs and
    -- jobs named with rerun_disabled_tests are excluded.
    ran_on                       Enum8('main' = 1, 'pull_request' = 2),

    -- window selects a duration from {3h, 12h, 1d, 3d, 7d, 14d}.
    -- A run counts when refreshed_at - duration <= first_attempt.started_at
    -- <= refreshed_at. Skips, attempts, the mean and total durations and last_*
    -- use each attempt's own started_at.
    -- Windows overlap; do not sum them. A row exists iff
    -- attempts + skipped_runs > 0, so a window holding only retries of an older
    -- run has runs = 0.
    window                       Enum8('3h' = 1, '12h' = 2, '1d' = 3, '3d' = 4, '7d' = 5, '14d' = 6),

    -- Sorted, distinct calling workflow paths from default.workflow_run.path
    -- for attempts in this window, including retries and skipped attempts.
    -- These are the calling files, not the reusable workflows they reference.
    -- Missing/empty paths are omitted; [] means no known path. When combining
    -- code sources, union these arrays; do not concatenate duplicates.
    workflow_paths               Array(String),

    -- runs = count(logical runs starting in the window)
    --      = passed_runs + failed_runs + other_runs.
    -- other_runs counts runs with no failure whose first outcome was not passed
    -- (unknown, xfailed or xpassed). Skips do not add a run; retries are folded in.
    -- This is the denominator for failed_runs / runs and flaky_runs / runs.
    runs                         UInt32,

    -- passed_runs = count(runs whose first attempt passed and no attempt failed)
    --             = runs - failed_runs - other_runs.
    -- Here and below, failures include failed, error, crashed and timed_out.
    passed_runs                  UInt32,

    -- failed_runs = count(runs with at least one failure)
    --             = flaky_runs + unrecovered_runs.
    -- unrecovered_runs counts failed runs whose last observed attempt did not
    -- pass. An earlier pass does not make the run flaky if it ended failing.
    failed_runs                  UInt32,

    -- flaky_runs = count(runs with a failure AND last observed outcome = passed)
    --            = failed_runs - unrecovered_runs.
    -- Therefore 0 <= flaky_runs <= failed_runs <= runs. Later-arriving retries
    -- can change the last observed outcome on the next refresh.
    flaky_runs                   UInt32,

    -- skipped_runs = count(attempts in the window whose outcome = 'skipped').
    -- Skipped retries also count. A failed run with a skipped retry can contribute
    -- to both failed_runs and skipped_runs in the same window.
    skipped_runs                 UInt32,

    -- attempts = count(attempts in the window whose outcome != 'skipped'),
    -- first attempts and retries alike, each at its own started_at like
    -- skipped_runs, so a retry of a run that started earlier counts here.
    -- The denominator of mean_duration_milliseconds. Across rows,
    -- sum(total_duration_milliseconds) / sum(attempts) is the exact mean.
    attempts                     UInt32,

    -- Let passed_ms = sum(max(0, dateDiff('millisecond', started_at, ended_at)))
    -- over the first attempt of each passed_run; successful retries are excluded.
    -- mean_passed_duration_milliseconds = NULL if passed_runs = 0, otherwise
    --   intDiv(passed_ms + intDiv(passed_runs, 2), passed_runs).
    -- This rounds half up. Combining these rounded means weighted by passed_runs
    -- gives an approximate overall mean.
    mean_passed_duration_milliseconds Nullable(UInt32),

    -- Let total_ms = sum(max(0, dateDiff('millisecond', started_at, ended_at)))
    -- over the attempts counted in attempts.
    -- mean_duration_milliseconds = NULL if attempts = 0, otherwise
    --   intDiv(total_ms + intDiv(attempts, 2), attempts).
    -- This rounds half up. Unlike mean_passed_duration_milliseconds it counts
    -- failures, timeouts and retries. Combine rows through attempts and
    -- total_duration_milliseconds, not through these means.
    mean_duration_milliseconds   Nullable(UInt32),

    -- total_duration_milliseconds = total_ms, the machine time the test
    -- consumed in the window; 0 when nothing executed. Rows of different ran_on
    -- add exactly; windows overlap.
    total_duration_milliseconds  UInt64,

    -- last_run_at = maxOrNullIf(started_at, outcome != 'skipped')
    -- over attempts in the window. Includes retries even when their logical run
    -- started before the window; NULL when no such attempt exists.
    last_run_at                  Nullable(DateTime64(3, 'UTC')),

    -- last_failed_at = maxOrNullIf(started_at,
    --   outcome IN ('failed', 'error', 'crashed', 'timed_out'))
    -- over attempts in the window, including retries; NULL if none failed.
    -- Can be non-NULL with failed_runs = 0 when the failed run started earlier.
    last_failed_at               Nullable(DateTime64(3, 'UTC')),

    -- refreshed_at = now('UTC'), captured once at the refresh-query start.
    -- All rows from that refresh share this timestamp, at second precision.
    refreshed_at                 DateTime('UTC')
)
ENGINE = MergeTree
PARTITION BY (ran_on, window)
ORDER BY (tests_id, environments_id, env_vars_id);

CREATE MATERIALIZED VIEW health_mv
REFRESH EVERY 15 MINUTE
TO health
AS
WITH
    now('UTC') AS refresh_time,
    -- Job metadata is independent of individual test attempts. ANY prevents
    -- repeated workflow catalog rows from multiplying attempts.
    jobs AS (
        SELECT
            job.id AS id,
            job_run.path AS workflow_path,
            multiIf(
                job.head_branch = 'main' AND job_run.event IN ('push', 'schedule'), 1,
                job_run.event = 'pull_request'
                    OR (job_run.event = 'push' AND startsWith(job.head_branch, 'ciflow/')), 2,
                0
            ) AS ran_on
        FROM (
            SELECT id, run_id, head_branch, name
            FROM default.workflow_job
            WHERE started_at >= refresh_time - INTERVAL 15 DAY
              AND name NOT LIKE '%rerun_disabled_tests%'
        ) AS job
        ANY LEFT JOIN (
            SELECT id, event, path
            FROM default.workflow_run
            WHERE id IN (
                SELECT run_id
                FROM default.workflow_job
                WHERE started_at >= refresh_time - INTERVAL 15 DAY
            )
        ) AS job_run ON job_run.id = job.run_id
        WHERE ran_on != 0
    ),
    -- Only tests with failures need the more expensive process reconstruction.
    -- tests_id leads the runs sort key, so this set prunes the second scan.
    failing_tests AS (
        SELECT DISTINCT tests_id
        FROM runs FINAL
        WHERE started_at >= refresh_time - INTERVAL 14 DAY
          AND started_at <= refresh_time
          AND outcome IN ('failed', 'error', 'crashed', 'timed_out')
    ),
    -- Aggregate six buckets for the counts and observed workflow paths.
    -- ANY prevents repeated job rows from multiplying attempts. The query's
    -- read-in-order-through-join setting preserves ordered aggregation here.
    common_counts AS (
        SELECT
            tests_id,
            environments_id,
            env_vars_id,
            attempts.ran_on AS ran_on,
            groupUniqArrayIfResample(1, 7, 1)(workflow.workflow_path, notEmpty(workflow.workflow_path), bucket) AS workflow_path_buckets,
            countIfResample(1, 7, 1)(rerun_number = 0 AND outcome != 'skipped', bucket) AS firsts,
            countIfResample(1, 7, 1)(rerun_number = 0 AND outcome = 'passed', bucket) AS passed,
            sumIfResample(1, 7, 1)(duration_ms, rerun_number = 0 AND outcome = 'passed', bucket) AS passed_ms,
            countIfResample(1, 7, 1)(outcome != 'skipped', bucket) AS executed_attempts,
            sumIfResample(1, 7, 1)(duration_ms, outcome != 'skipped', bucket) AS total_ms,
            countIfResample(1, 7, 1)(outcome = 'skipped', bucket) AS skipped,
            maxOrNullIfResample(1, 7, 1)(started_at, outcome != 'skipped', bucket) AS last_run,
            maxOrNullIfResample(1, 7, 1)(started_at, outcome IN ('failed', 'error', 'crashed', 'timed_out'), bucket) AS last_failed
        FROM (
            SELECT
                tests_id,
                environments_id,
                env_vars_id,
                github_workflow_job_id,
                rerun_number,
                outcome,
                started_at,
                greatest(0, dateDiff('millisecond', started_at, ended_at)) AS duration_ms,
                -- Main wins if duplicate job records name both sources.
                -- The workflow join below excludes jobs outside either source.
                if(github_workflow_job_id IN (SELECT id FROM jobs WHERE ran_on = 1), 1, 2) AS ran_on,
                multiIf(
                    started_at >= refresh_time - INTERVAL 3 HOUR, 1,
                    started_at >= refresh_time - INTERVAL 12 HOUR, 2,
                    started_at >= refresh_time - INTERVAL 1 DAY, 3,
                    started_at >= refresh_time - INTERVAL 3 DAY, 4,
                    started_at >= refresh_time - INTERVAL 7 DAY, 5, 6
                ) AS bucket
            FROM runs FINAL
            WHERE started_at >= refresh_time - INTERVAL 14 DAY
              AND started_at <= refresh_time
        ) AS attempts
        ANY LEFT JOIN jobs AS workflow ON workflow.id = attempts.github_workflow_job_id
        WHERE workflow.ran_on != 0
        GROUP BY tests_id, environments_id, env_vars_id, attempts.ran_on
    ),
    processes AS (
        SELECT
            tests_id,
            environments_id,
            env_vars_id,
            github_workflow_job_id,
            report_uuid,
            multiIf(
                github_workflow_job_id IN (SELECT id FROM jobs WHERE ran_on = 1), 1,
                github_workflow_job_id IN (SELECT id FROM jobs WHERE ran_on = 2), 2, 0
            ) AS ran_on,
            -- Ordinals preserve the first attempt even if the clock went back.
            argMin(started_at, (rerun_number, started_at)) AS process_started_at,
            -- First rows and their passes per window bucket, so corrections
            -- leave the buckets common_counts added them to: a process without
            -- report UUIDs can span buckets.
            countIfResample(1, 7, 1)(rerun_number = 0 AND outcome != 'skipped', bucket) AS firsts,
            arraySum(firsts) > 0 AS executed,
            max(outcome IN ('failed', 'error', 'crashed', 'timed_out')) AS failed,
            argMax(outcome, (rerun_number, started_at, ended_at)) AS final_outcome,
            final_outcome = 'passed' AS ended_passing,
            executed AND final_outcome IN ('failed', 'error', 'crashed', 'timed_out') AS ended_failing,
            countIfResample(1, 7, 1)(rerun_number = 0 AND outcome = 'passed', bucket) AS passed_firsts,
            sumIfResample(1, 7, 1)(duration_ms, rerun_number = 0 AND outcome = 'passed', bucket) AS passed_firsts_ms
        FROM (
            SELECT
                tests_id,
                environments_id,
                env_vars_id,
                github_workflow_job_id,
                report_uuid,
                rerun_number,
                outcome,
                started_at,
                ended_at,
                greatest(0, dateDiff('millisecond', started_at, ended_at)) AS duration_ms,
                multiIf(
                    started_at >= refresh_time - INTERVAL 3 HOUR, 1,
                    started_at >= refresh_time - INTERVAL 12 HOUR, 2,
                    started_at >= refresh_time - INTERVAL 1 DAY, 3,
                    started_at >= refresh_time - INTERVAL 3 DAY, 4,
                    started_at >= refresh_time - INTERVAL 7 DAY, 5, 6
                ) AS bucket
            FROM runs FINAL
            WHERE tests_id IN failing_tests
              AND started_at >= refresh_time - INTERVAL 14 DAY
              AND started_at <= refresh_time
        )
        WHERE ran_on != 0
        GROUP BY tests_id, environments_id, env_vars_id, github_workflow_job_id, report_uuid, ran_on
    ),
    run_chains AS (
        SELECT
            tests_id,
            environments_id,
            env_vars_id,
            ran_on,
            -- Tuple: start, ended failing, had failure, first rows per bucket,
            -- ended passing, passing first rows per bucket, their durations per
            -- bucket, and whether it executed.
            -- Put a failed process first when start timestamps tie.
            arraySort(process -> (process.1, 1 - process.2), groupArray(
                (process_started_at, ended_failing, failed, firsts,
                 ended_passing, passed_firsts, passed_firsts_ms, executed)
            )) AS ordered_processes,
            arrayMap(i -> i = 1 OR NOT ordered_processes[i - 1].2,
                arrayEnumerate(ordered_processes)) AS starts,
            arrayMap(i -> i = length(ordered_processes) OR starts[i + 1],
                arrayEnumerate(ordered_processes)) AS ends,
            arrayReverseFill((passed, is_end) -> is_end,
                arrayMap(process -> process.5, ordered_processes), ends) AS run_ends_passing
        FROM processes
        GROUP BY tests_id, environments_id, env_vars_id, github_workflow_job_id, ran_on
        HAVING max(failed)
    ),
    -- Correct only failing combinations: remove retry starts and their pass
    -- durations, then count failed/flaky runs at the original process start.
    -- A run start lands in its process's bucket; removed first rows and
    -- passes leave the buckets common_counts put them in.
    corrections AS (
        SELECT
            tests_id,
            environments_id,
            env_vars_id,
            ran_on,
            arrayCumSum(arrayMap((started, removed) -> started - toInt64(removed),
                sumResample(1, 7, 1)(toInt64(starts_run AND process.8), bucket),
                sumForEach(process.4))) AS runs,
            arrayCumSum(arrayMap(removed -> -toInt64(removed),
                sumForEachIf(process.6, NOT starts_run OR process.3))) AS passed,
            arrayCumSum(arrayMap(removed -> -toInt64(removed),
                sumForEachIf(process.7, NOT starts_run OR process.3))) AS passed_ms,
            arrayCumSum(countIfResample(1, 7, 1)(starts_run AND process.8 AND process.3, bucket)) AS failed,
            arrayCumSum(countIfResample(1, 7, 1)(starts_run AND process.8 AND process.3 AND run_ended_passing, bucket)) AS flaky
        FROM (
            SELECT
                tests_id,
                environments_id,
                env_vars_id,
                ran_on,
                process,
                starts_run,
                run_ended_passing,
                multiIf(
                    process.1 >= refresh_time - INTERVAL 3 HOUR, 1,
                    process.1 >= refresh_time - INTERVAL 12 HOUR, 2,
                    process.1 >= refresh_time - INTERVAL 1 DAY, 3,
                    process.1 >= refresh_time - INTERVAL 3 DAY, 4,
                    process.1 >= refresh_time - INTERVAL 7 DAY, 5, 6
                ) AS bucket
            FROM run_chains
            ARRAY JOIN ordered_processes AS process, starts AS starts_run, run_ends_passing AS run_ended_passing
        )
        GROUP BY tests_id, environments_id, env_vars_id, ran_on
    )
SELECT
    tests_id,
    environments_id,
    env_vars_id,
    CAST(ran_on AS Enum8('main' = 1, 'pull_request' = 2)) AS ran_on,
    CAST(window_number AS Enum8('3h' = 1, '12h' = 2, '1d' = 3, '3d' = 4, '7d' = 5, '14d' = 6)) AS window,
    known_workflow_paths AS workflow_paths,
    toUInt32(run_count) AS runs,
    toUInt32(passed_count) AS passed_runs,
    toUInt32(failed_count) AS failed_runs,
    toUInt32(flaky_count) AS flaky_runs,
    toUInt32(skipped_count) AS skipped_runs,
    toUInt32(attempt_count) AS attempts,
    if(passed_runs > 0,
        toUInt32(intDiv(passed_duration_ms + intDiv(passed_runs, 2), greatest(passed_runs, 1))),
        NULL) AS mean_passed_duration_milliseconds,
    if(attempts > 0,
        toUInt32(intDiv(total_duration_ms + intDiv(attempts, 2), greatest(attempts, 1))),
        NULL) AS mean_duration_milliseconds,
    toUInt64(total_duration_ms) AS total_duration_milliseconds,
    newest_run AS last_run_at,
    newest_failed AS last_failed_at,
    refresh_time AS refreshed_at
FROM (
    SELECT
        common_counts.tests_id AS tests_id,
        common_counts.environments_id AS environments_id,
        common_counts.env_vars_id AS env_vars_id,
        common_counts.ran_on AS ran_on,
        common_counts.workflow_path_buckets AS workflow_path_buckets,
        common_counts.firsts AS firsts,
        common_counts.passed AS passed,
        common_counts.passed_ms AS passed_ms,
        common_counts.executed_attempts AS executed_attempts,
        common_counts.total_ms AS total_ms,
        common_counts.skipped AS skipped,
        common_counts.last_run AS last_run,
        common_counts.last_failed AS last_failed,
        arrayResize(corrections.runs, 6) AS run_adjustments,
        arrayResize(corrections.passed, 6) AS passed_adjustments,
        arrayResize(corrections.passed_ms, 6) AS duration_adjustments,
        arrayResize(corrections.failed, 6) AS failed,
        arrayResize(corrections.flaky, 6) AS flaky
    FROM common_counts
    LEFT JOIN corrections
        ON corrections.tests_id = common_counts.tests_id
        AND corrections.environments_id = common_counts.environments_id
        AND corrections.env_vars_id = common_counts.env_vars_id
        AND corrections.ran_on = common_counts.ran_on
)
-- The small corrections side is absent for clean combinations. Pad it with
-- zeros, then produce one row per cumulative window from the same six arrays.
ARRAY JOIN
    arrayMap(i -> arraySort(arrayDistinct(arrayFlatten(arraySlice(workflow_path_buckets, 1, i)))), range(1, 7)) AS known_workflow_paths,
    arrayMap((n, delta) -> toInt64(n) + delta, arrayCumSum(firsts), run_adjustments) AS run_count,
    arrayMap((n, delta) -> toInt64(n) + delta, arrayCumSum(passed), passed_adjustments) AS passed_count,
    arrayMap((n, delta) -> n + delta, arrayCumSum(passed_ms), duration_adjustments) AS passed_duration_ms,
    arrayCumSum(executed_attempts) AS attempt_count,
    arrayCumSum(total_ms) AS total_duration_ms,
    failed AS failed_count,
    flaky AS flaky_count,
    arrayCumSum(skipped) AS skipped_count,
    arrayMap(i -> arrayMax(arraySlice(last_run, 1, i)), range(1, 7)) AS newest_run,
    arrayMap(i -> arrayMax(arraySlice(last_failed, 1, i)), range(1, 7)) AS newest_failed,
    range(1, 7) AS window_number
WHERE attempts + skipped_runs > 0
SETTINGS optimize_aggregation_in_order = 1, query_plan_read_in_order_through_join = 1;
