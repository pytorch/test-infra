-- Time to green TD saves per green PR push on pytorch/pytorch. A push is a first-attempt `pull`
-- run of a pull_request event whose TD test jobs all completed with success (at least one) and in
-- which no job, builds included, failed, was cancelled or timed out. From the run's creation:
-- actual end = the last TD test job's completion; estimated end = the latest
-- (job start + the job's mean duration on main pushes in the window), keeping the actual duration
-- for jobs whose key has fewer than 5 main jobs. Job keys as in td_ci_savings. Medians over
-- pushes for the times, means for the hours. One row per run creation day, one per week of it
-- (bucket = its ISO Monday) and one total.
--
-- Jobs are scanned by created_at from a day before the window to a day after it: GitHub cancels
-- jobs queued over 24 hours, so a job started in the window was created at most a day earlier;
-- the extra day after the window holds the first-attempt jobs of runs created near its end.
--
-- Other jobs enter a push only when they failed, as ok = 0 rows that drop the push, so the
-- times and hours of every remaining push come from its TD test jobs alone.
--
-- Each job id is collapsed first: unmerged queued or in_progress rows of a finished job must not
-- make its push look unfinished, nor count its duration twice.
--
-- On empty input the () grouping set still returns its row, so the total row is always present.
-- Every CTE is referenced once: ClickHouse re-runs a CTE at each reference.
WITH
least({stopTime: DateTime64(3)}, now64(3)) AS window_end,
greatest(
    {startTime: DateTime64(3)}, window_end - INTERVAL 365 DAY
) AS window_start,

main_runs AS (
    SELECT id FROM default.workflow_run
    WHERE
        id IN (
            SELECT id FROM materialized_views.workflow_run_by_created_at
            WHERE
                created_at >= window_start - INTERVAL 7 DAY
                AND created_at < window_end
        )
        AND head_branch = 'main'
        AND event = 'push'
        AND head_repository.full_name = 'pytorch/pytorch'
),

job_rows AS (
    SELECT
        id,
        run_id,
        started_at,
        completed_at,
        status = 'completed' AND conclusion = 'success' AS ok_row,
        position(name, ' / test (') > 0
        AND NOT multiSearchAny(name, ['macos', 'xpu', 'onnx']) AS is_td_test,
        conclusion IN ('failure', 'cancelled', 'timed_out') AS failed_row,
        splitByString(' / test (', name) AS name_parts,
        splitByString(', ', trimRight(name_parts[2], ')')) AS test_args,
        concat(
            workflow_name, ' / ', name_parts[1], ' / test (',
            arrayStringConcat(
                arrayFilter(
                    (x, i) -> i != 4, test_args, arrayEnumerate(test_args)
                ),
                ', '
            ),
            ')'
        ) AS job_key,
        dictGet(
            'default.workflow_events_dict', 'event',
            dictGet('default.workflow_run_dict', 'event_hash', run_id)
        ) AS event,
        dictGet('default.workflow_run_dict', 'created_at', run_id)
            AS run_created,
        event = 'pull_request'
        AND run_attempt = 1
        AND run_created >= window_start
        AND run_created < window_end AS is_push_row,
        ok_row
        AND is_td_test
        AND started_at >= window_start
        AND started_at < window_end
        AND head_branch = 'main'
        AND event = 'push'
        AND run_id IN (SELECT id FROM main_runs) AS is_main_row
    FROM default.workflow_job
    WHERE
        created_at >= window_start - INTERVAL 1 DAY
        AND created_at < window_end + INTERVAL 1 DAY
        AND startsWith(dynamoKey, 'pytorch/pytorch/')
        AND workflow_name = 'pull'
),

jobs AS (
    SELECT
        any(run_id) AS run_id,
        any(job_key) AS job_key,
        any(run_created) AS run_created,
        max(is_main_row) AS is_main,
        max(is_push_row) AS is_push_job,
        max(ok_row) AS ok,
        max(is_td_test) AS is_test,
        max(failed_row) AS failed,
        minIf(started_at, ok_row) AS started,
        minIf(completed_at, ok_row) AS completed,
        toFloat64(dateDiff('second', started, completed)) AS dur,
        toFloat64(dateDiff('second', run_created, started)) AS start_offset,
        toFloat64(dateDiff('second', run_created, completed)) AS end_offset
    FROM job_rows
    WHERE is_push_row OR is_main_row
    GROUP BY id
),

keys AS (
    SELECT
        countIf(is_main) >= 5 AS matched,
        avgIf(dur, is_main) AS main_mean,
        groupArrayIf(
            (run_id, run_created, start_offset, end_offset, dur, ok, is_test),
            is_push_job AND (is_test OR failed)
        ) AS push_jobs
    FROM jobs
    GROUP BY job_key
),

push_job_rows AS (
    SELECT
        matched,
        main_mean,
        arrayJoin(push_jobs) AS push_job
    FROM keys
),

pushes AS (
    SELECT
        tupleElement(push_job, 1) AS run_id,
        any(tupleElement(push_job, 2)) AS created,
        formatDateTime(created, '%F') AS push_day,
        formatDateTime(toMonday(created), '%F') AS push_week,
        max(tupleElement(push_job, 4)) / 60 AS actual_ttg,
        max(
            tupleElement(push_job, 3)
            + if(matched, main_mean, tupleElement(push_job, 5))
        )
        / 60 AS est_ttg,
        sum(tupleElement(push_job, 5)) / 3600 AS push_hours,
        sum(if(matched, main_mean, tupleElement(push_job, 5)))
        / 3600 AS est_push_hours
    FROM push_job_rows
    GROUP BY run_id
    HAVING min(tupleElement(push_job, 6)) AND max(tupleElement(push_job, 7))
)

SELECT
    multiIf(
        grouping(push_day) = 0, 'day',
        grouping(push_week) = 0, 'week',
        'total'
    ) AS grain,
    multiIf(grain = 'day', push_day, grain = 'week', push_week, '') AS bucket,
    count() AS pushes,
    ifNotFinite(quantileExact(0.5) (actual_ttg), 0) AS actual_ttg_median_min,
    ifNotFinite(quantileExact(0.5) (est_ttg), 0) AS est_ttg_median_min,
    ifNotFinite(quantileExact(0.5) (est_ttg - actual_ttg), 0)
        AS saved_median_min,
    ifNotFinite(avg(push_hours), 0) AS hours_per_push,
    ifNotFinite(avg(est_push_hours), 0) AS est_hours_per_push
FROM pushes
GROUP BY GROUPING SETS ((push_day), (push_week), ())
ORDER BY grain, bucket
SETTINGS max_execution_time = 60, max_threads = 8
