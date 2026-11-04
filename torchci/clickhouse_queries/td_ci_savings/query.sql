-- CI time TD saves on pytorch/pytorch PRs: actual test-job time of successful TD test jobs on PR
-- runs (pull_request events and ciflow tag pushes) against the same job's mean and median duration
-- on main pushes in the same window, the full-suite estimate. One row per job start day, one per
-- week of it (bucket = its ISO Monday), one per config and one total.
--
-- The job key drops only the runner label (4th argument of "test (...)"): labels change with
-- runner fleet moves while the job stays the same; shard numbers stay, since a shard's duration
-- depends on its count. Keys with fewer than 5 main jobs have no baseline: their PR jobs count
-- as unmatched_jobs and stay out of every other column; a config row with jobs = 0 has medians 0.
--
-- Main runs are looked up among runs created from 7 days before the window: a main job started
-- inside the window from an older run (a late re-run) is left out of the baseline.
--
-- On empty input the () grouping set still returns its row, so the total row is always present.
WITH
least({stopTime: DateTime64(3)}, now64(3)) AS window_end,
greatest(
    {startTime: DateTime64(3)}, window_end - INTERVAL 365 DAY
) AS window_start

SELECT
    multiIf(
        grouping(job_day) = 0, 'day',
        grouping(job_week) = 0, 'week',
        grouping(job_config) = 0, 'config',
        'total'
    ) AS grain,
    multiIf(grain = 'day', job_day, grain = 'week', job_week, '') AS bucket,
    if(grain = 'config', job_config, '') AS config,
    countIf(matched) AS jobs,
    countIf(NOT matched) AS unmatched_jobs,
    sumIf(dur, matched) / 3600 AS pr_hours,
    sumIf(main_mean, matched) / 3600 AS est_full_hours,
    ifNotFinite(medianExactIf(dur, matched) / 60, 0) AS pr_median_min,
    ifNotFinite(medianExactIf(main_median, matched) / 60, 0) AS full_median_min
FROM (
    SELECT
        job_config,
        main_jobs >= 5 AS matched,
        main_mean,
        main_median,
        arrayJoin(pr_jobs) AS pr_job,
        formatDateTime(tupleElement(pr_job, 1), '%F') AS job_day,
        formatDateTime(toMonday(tupleElement(pr_job, 1)), '%F') AS job_week,
        tupleElement(pr_job, 2) AS dur
    FROM (
        SELECT
            job_config,
            countIf(is_main) AS main_jobs,
            avgIf(dur, is_main) AS main_mean,
            medianExactIf(dur, is_main) AS main_median,
            groupArrayIf((toDate(started_at), dur), is_pr) AS pr_jobs
        FROM (
            SELECT
                started_at,
                toFloat64(dateDiff('second', started_at, completed_at)) AS dur,
                splitByString(' / test (', name) AS name_parts,
                splitByString(', ', trimRight(name_parts[2], ')')) AS test_args,
                concat(
                    workflow_name, ' / ', name_parts[1], ' / test (',
                    arrayStringConcat(
                        arrayFilter(
                            (x, i) -> i != 4,
                            test_args,
                            arrayEnumerate(test_args)
                        ),
                        ', '
                    ),
                    ')'
                ) AS job_key,
                concat(
                    workflow_name, ' / ', name_parts[1], ' / ', test_args[1]
                ) AS job_config,
                dictGet(
                    'default.workflow_events_dict', 'event',
                    dictGet('default.workflow_run_dict', 'event_hash', run_id)
                ) AS event,
                event = 'pull_request' OR head_branch LIKE 'ciflow/%' AS is_pr,
                head_branch = 'main' AND event = 'push' AND run_id IN (
                    SELECT id FROM default.workflow_run
                    WHERE
                        id IN (
                            SELECT id
                            FROM materialized_views.workflow_run_by_created_at
                            WHERE
                                created_at >= window_start - INTERVAL 7 DAY
                                AND created_at < window_end
                        )
                        AND head_branch = 'main'
                        AND event = 'push'
                        AND head_repository.full_name = 'pytorch/pytorch'
                ) AS is_main
            FROM default.workflow_job
            WHERE
                started_at >= window_start
                AND started_at < window_end
                AND startsWith(dynamoKey, 'pytorch/pytorch/')
                AND status = 'completed'
                AND conclusion = 'success'
                AND position(name, ' / test (') > 0
                AND (
                    workflow_name IN ('pull', 'trunk')
                    OR startsWith(workflow_name, 'rocm-')
                    OR startsWith(workflow_name, 'periodic-rocm-')
                )
                AND NOT multiSearchAny(name, ['macos', 'xpu', 'onnx'])
            LIMIT 1 BY id
        )
        WHERE is_pr OR is_main
        GROUP BY job_key, job_config
    )
)
GROUP BY GROUPING SETS ((job_day), (job_week), (job_config), ())
ORDER BY grain, bucket, config
SETTINGS max_execution_time = 60, max_threads = 8
