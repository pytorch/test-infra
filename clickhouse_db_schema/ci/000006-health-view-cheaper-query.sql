-- noqa: disable=CP05,LT01
-- A cheaper query for health_mv (000002) that writes the same rows; its
-- semantics, windows and columns are 000002's. On 2026-11-06, with 14 days
-- in runs (17.1B rows), each 000002 refresh took 23 to 67 minutes (median
-- 28) and peaked at 60 GiB, so refreshes ran back to back. This query:
-- - aggregates attempts in order of the runs sort key under both analyzers:
--   main and pull request buckets are twelve slots of one GROUP BY on the
--   key prefix, and the job lookup is an INNER JOIN without spilling (an ANY
--   LEFT JOIN or a spillable join makes the new analyzer hash-aggregate);
-- - carries each job's workflow path as an integer code and turns the codes
--   back into paths at the end, instead of collecting strings per attempt;
-- - rebuilds processes only for the (test, environment, env vars, job) pairs
--   with a failure, instead of every process of every failing test;
-- - reads the clock once. Under the old analyzer each subquery reads now()
--   again: on Cloud 26.6, 000002's windows read it ~0.1 s after refreshed_at,
--   so some refreshes counted every window from a second after their stamp.
ALTER TABLE health_mv MODIFY QUERY
WITH
    -- The refresh's clock: a scalar subquery runs once per query. Its type is
    -- Nullable, so the CAST keeps refreshed_at a DateTime('UTC') like health's.
    CAST((SELECT now('UTC')) AS DateTime('UTC')) AS refresh_time,
    -- Every workflow path ever seen, as (codes, paths): the table that turns
    -- the path codes below back into paths. A scalar runs once per query.
    (
        SELECT (
            arrayMap(entry -> entry.1, entries),
            arrayMap(entry -> entry.2, entries))
        FROM (
            SELECT groupUniqArray((
                bitOr(288230376151711744, bitAnd(cityHash64(path), 288230376151711743)), path)) AS entries
            FROM default.workflow_run
            WHERE notEmpty(path)
        )
    ) AS path_table,
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
    -- One row per included job: main wins if duplicate job records name both
    -- sources. The path travels as a 59-bit code (bit 58 marks a known path,
    -- the low 58 bits are its hash) so attempts carry integers, not strings;
    -- the final SELECT turns codes back into paths.
    job_codes AS (
        SELECT
            id,
            if(max(ran_on = 1), 1, 2) AS ran_on,
            any(if(empty(workflow_path), 0,
                bitOr(288230376151711744, bitAnd(cityHash64(workflow_path), 288230376151711743)))) AS path_code
        FROM jobs
        GROUP BY id
    ),
    -- Only (test, environment, env vars, job) pairs with a failure need the
    -- more expensive process reconstruction. Without FINAL this can include
    -- pairs whose failure a later duplicate replaced; run_chains drops those.
    failing_pairs AS (
        SELECT DISTINCT tests_id, environments_id, env_vars_id, github_workflow_job_id
        FROM runs
        PREWHERE outcome IN ('failed', 'error', 'crashed', 'timed_out')
        WHERE started_at >= refresh_time - INTERVAL 14 DAY
          AND started_at <= refresh_time
    ),
    -- Aggregate twelve slots, six buckets for main then six for pull requests,
    -- so the GROUP BY is the runs sort-key prefix and aggregates in order.
    -- Paths are one set of (slot << 59) | path_code per combination.
    common_counts AS (
        SELECT
            tests_id,
            environments_id,
            env_vars_id,
            groupUniqArrayIf(bitOr(bitShiftLeft(toUInt64(slot), 59), path_code), path_code != 0) AS workflow_path_codes,
            countIfResample(1, 13, 1)(rerun_number = 0 AND outcome != 'skipped', slot) AS firsts_by_slot,
            countIfResample(1, 13, 1)(rerun_number = 0 AND outcome = 'passed', slot) AS passed_by_slot,
            sumIfResample(1, 13, 1)(duration_ms, rerun_number = 0 AND outcome = 'passed', slot) AS passed_ms_by_slot,
            countIfResample(1, 13, 1)(outcome != 'skipped', slot) AS executed_attempts_by_slot,
            sumIfResample(1, 13, 1)(duration_ms, outcome != 'skipped', slot) AS total_ms_by_slot,
            countIfResample(1, 13, 1)(outcome = 'skipped', slot) AS skipped_by_slot,
            maxOrNullIfResample(1, 13, 1)(started_at, outcome != 'skipped', slot) AS last_run_by_slot,
            maxOrNullIfResample(1, 13, 1)(started_at, outcome IN ('failed', 'error', 'crashed', 'timed_out'), slot) AS last_failed_by_slot
        FROM (
            SELECT
                attempt.tests_id AS tests_id,
                attempt.environments_id AS environments_id,
                attempt.env_vars_id AS env_vars_id,
                attempt.rerun_number AS rerun_number,
                attempt.outcome AS outcome,
                attempt.started_at AS started_at,
                attempt.duration_ms AS duration_ms,
                workflow.path_code AS path_code,
                attempt.bucket + 6 * (workflow.ran_on - 1) AS slot
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
            ) AS attempt
            -- job_codes has one row per id, so the ALL INNER JOIN keeps each
            -- attempt of an included job once (ANY INNER would keep one per
            -- job). The new analyzer stops reading in order through ANY LEFT.
            ALL INNER JOIN job_codes AS workflow ON workflow.id = attempt.github_workflow_job_id
        )
        GROUP BY tests_id, environments_id, env_vars_id
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
            -- Sort-key columns only: a duplicate and its replacement share
            -- them, so filtering before FINAL keeps its deduplication exact.
            PREWHERE (tests_id, environments_id, env_vars_id, github_workflow_job_id) IN failing_pairs
            WHERE started_at >= refresh_time - INTERVAL 14 DAY
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
        split.tests_id AS tests_id,
        split.environments_id AS environments_id,
        split.env_vars_id AS env_vars_id,
        split.ran_on AS ran_on,
        split.workflow_path_buckets AS workflow_path_buckets,
        split.firsts AS firsts,
        split.passed AS passed,
        split.passed_ms AS passed_ms,
        split.executed_attempts AS executed_attempts,
        split.total_ms AS total_ms,
        split.skipped AS skipped,
        split.last_run AS last_run,
        split.last_failed AS last_failed,
        arrayResize(corrections.runs, 6) AS run_adjustments,
        arrayResize(corrections.passed, 6) AS passed_adjustments,
        arrayResize(corrections.passed_ms, 6) AS duration_adjustments,
        arrayResize(corrections.failed, 6) AS failed,
        arrayResize(corrections.flaky, 6) AS flaky
    FROM (
        -- One row per combination and code source that has attempts or skips,
        -- with that source's six buckets. Path codes become paths per bucket.
        SELECT
            tests_id,
            environments_id,
            env_vars_id,
            ran_on,
            arrayMap(bucket -> arrayFilter(path -> notEmpty(path), arrayMap(
                    code -> transform(bitAnd(code, 576460752303423487), path_table.1, path_table.2, ''),
                    arrayFilter(code -> bitShiftRight(code, 59) = bucket + 6 * (ran_on - 1), workflow_path_codes))),
                range(1, 7)) AS workflow_path_buckets,
            arraySlice(firsts_by_slot, 6 * ran_on - 5, 6) AS firsts,
            arraySlice(passed_by_slot, 6 * ran_on - 5, 6) AS passed,
            arraySlice(passed_ms_by_slot, 6 * ran_on - 5, 6) AS passed_ms,
            arraySlice(executed_attempts_by_slot, 6 * ran_on - 5, 6) AS executed_attempts,
            arraySlice(total_ms_by_slot, 6 * ran_on - 5, 6) AS total_ms,
            arraySlice(skipped_by_slot, 6 * ran_on - 5, 6) AS skipped,
            arraySlice(last_run_by_slot, 6 * ran_on - 5, 6) AS last_run,
            arraySlice(last_failed_by_slot, 6 * ran_on - 5, 6) AS last_failed
        FROM common_counts
        ARRAY JOIN [1, 2] AS ran_on
        WHERE arraySum(arraySlice(executed_attempts_by_slot, 6 * ran_on - 5, 6))
            + arraySum(arraySlice(skipped_by_slot, 6 * ran_on - 5, 6)) > 0
    ) AS split
    LEFT JOIN corrections
        ON corrections.tests_id = split.tests_id
        AND corrections.environments_id = split.environments_id
        AND corrections.env_vars_id = split.env_vars_id
        AND corrections.ran_on = split.ran_on
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
-- Aggregating in order of the runs sort key keeps memory flat. A join that may
-- spill to disk (the 26.6 default max_bytes_ratio_before_external_join = 0.5)
-- turns reading in order off, so it is disabled; every join side here is small.
SETTINGS optimize_aggregation_in_order = 1, query_plan_read_in_order_through_join = 1,
    max_bytes_ratio_before_external_join = 0;
