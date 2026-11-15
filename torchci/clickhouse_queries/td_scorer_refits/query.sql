-- The TD scorer's daily refit (pytorch/test-infra .github/workflows/td-scorer.yml): one row per
-- schedule or workflow_dispatch run on main created in the window, newest first, with the
-- state of its refit, check, publish and upload jobs and the figures of the report it uploaded.
--
-- Runs and jobs are ReplacingMergeTree tables with unmerged versions: each id keeps its newest
-- version. A "re-run failed jobs" attempt holds only the jobs it re-ran, so each job name takes
-- the newest attempt that has it. Jobs are found through their run's head sha.
--
-- The report is a misc.ossci_uploaded_metrics row with metric td_scorer_refit. Anyone who can
-- write that S3 prefix can write such a row, and every column of it is self-declared, so a row
-- counts only when its repo is pytorch/test-infra, its S3 key is exactly the one the workflow
-- writes for its own run id and attempt, and that attempt's `upload` job succeeded with its
-- upload step run, not skipped. The newest such attempt up to the run's latest wins. When one
-- key holds rows with different info (report_infos > 1), no figure is read from it.
-- Figures are read as nullable: a missing key or a null (a non-finite value) reads null, never 0.
--
-- ClickHouse runs a CTE at each reference: job_rows runs twice (the upload gate and the job
-- states) and runs three times (twice through job_rows, once for the output).
WITH
least({stopTime: DateTime64(3)}, now64(3)) AS window_end,
greatest(
    {startTime: DateTime64(3)},
    window_end - INTERVAL 90 DAY,
    -- The workflow's first day on main.
    toDateTime64('2026-11-12 00:00:00', 3)
) AS window_start,

runs AS (
    SELECT
        id AS run_id,
        run_attempt,
        created_at,
        status AS run_status,
        conclusion AS run_conclusion,
        head_sha
    FROM default.workflow_run
    WHERE
        id IN (
            SELECT id FROM materialized_views.workflow_run_by_created_at
            WHERE created_at >= window_start AND created_at < window_end
        )
        AND repository.full_name = 'pytorch/test-infra'
        AND path = '.github/workflows/td-scorer.yml'
        AND head_branch = 'main'
        AND event IN ('schedule', 'workflow_dispatch')
    ORDER BY run_attempt DESC, updated_at DESC, _inserted_at DESC
    LIMIT 1 BY id
),

job_rows AS (
    SELECT
        run_id,
        name,
        run_attempt,
        status,
        conclusion,
        if(
            status = 'completed',
            dateDiff('second', started_at, completed_at) / 60,
            NULL
        ) AS minutes,
        tupleElement(
            arrayFirst(s -> tupleElement(s, 'conclusion') = 'failure', steps),
            'name'
        ) AS failed_step,
        tupleElement(
            arrayFirst(
                s -> tupleElement(s, 'name') = 'Upload the report to HUD', steps
            ),
            'conclusion'
        ) AS upload_step
    FROM default.workflow_job
    WHERE
        id IN (
            SELECT id FROM materialized_views.workflow_job_by_head_sha
            WHERE (head_sha, run_id) IN (SELECT head_sha, run_id FROM runs)
        )
        AND name IN ('refit', 'check', 'publish', 'upload')
    ORDER BY id, status = 'completed' DESC, _inserted_at DESC
    LIMIT 1 BY id
),

uploads AS (
    SELECT
        run_id,
        run_attempt
    FROM job_rows
    WHERE
        name = 'upload'
        AND conclusion = 'success'
        AND upload_step = 'success'
),

jobs AS (
    SELECT
        run_id,
        anyIf(run_attempt, name = 'refit') AS refit_attempt,
        anyIf(conclusion, name = 'refit') AS refit_conclusion,
        anyIf(minutes, name = 'refit') AS refit_minutes,
        anyIf(failed_step, name = 'refit') AS refit_failed_step,
        anyIf(conclusion, name = 'check') AS check_conclusion,
        anyIf(conclusion, name = 'publish') AS publish_conclusion,
        anyIf(upload_step, name = 'upload') AS report_upload
    FROM (
        SELECT * FROM job_rows
        ORDER BY run_attempt DESC
        LIMIT 1 BY run_id, name
    )
    GROUP BY run_id
),

reports AS (
    SELECT
        run_id,
        run_attempt AS attempt,
        uniqExact(info) AS infos,
        any(info) AS body
    FROM misc.ossci_uploaded_metrics
    WHERE
        metric_name = 'td_scorer_refit'
        AND timestamp >= window_start
        AND repo = 'pytorch/test-infra'
        AND _meta.bucket = 'ossci-raw-job-status'
        AND _meta.key = concat(
            'ossci_uploaded_metrics/td_scorer_refit_',
            toString(run_id), '_', toString(run_attempt), '.jsonl.gz'
        )
        AND run_attempt > 0
        AND (run_id, run_attempt) IN (SELECT run_id, run_attempt FROM uploads)
    GROUP BY run_id, run_attempt
),

run_reports AS (
    SELECT
        r.run_id AS run_id,
        any(r.run_attempt) AS run_attempt,
        any(r.created_at) AS created_at,
        any(r.run_status) AS run_status,
        any(r.run_conclusion) AS run_conclusion,
        maxIf(
            p.attempt, p.attempt BETWEEN 1 AND r.run_attempt
        ) AS report_attempt,
        argMaxIf(
            p.infos, p.attempt, p.attempt BETWEEN 1 AND r.run_attempt
        ) AS report_infos,
        argMaxIf(
            p.body, p.attempt, p.attempt BETWEEN 1 AND r.run_attempt
        ) AS raw_info
    FROM runs AS r
    LEFT JOIN reports AS p ON p.run_id = r.run_id
    GROUP BY r.run_id
)

SELECT
    toString(run_id) AS run_id,
    created_at,
    run_status,
    run_conclusion,
    refit_attempt,
    refit_conclusion,
    refit_minutes,
    refit_failed_step,
    check_conclusion,
    publish_conclusion,
    report_upload,
    report_attempt,
    report_infos,
    isValidJSON(info) AS report_valid,
    JSONExtract(info, 'passed', 'Nullable(UInt8)') AS passed,
    JSONExtract(info, 'floor_ok', 'Nullable(UInt8)') AS floor_ok,
    JSONExtract(info, 'floor_ratio', 'Nullable(Float64)') AS floor_ratio,
    JSONHas(info, 'budget') AS budget_on,
    JSONExtract(info, 'budget', 'retention', 'Nullable(Float64)')
        AS budget_retention,
    JSONExtract(info, 'budget', 'retention_floor', 'Nullable(Float64)')
        AS budget_retention_floor,
    JSONExtract(info, 'budget', 'ok', 'Nullable(UInt8)') AS budget_ok,
    JSONExtract(info, 'budget', 'seconds_share', 'Nullable(Float64)')
        AS budget_seconds_share,
    JSONExtract(info, 'holdout', 'events', 'Nullable(Float64)')
        AS holdout_events,
    JSONExtract(info, 'holdout', 'td_caught', 'Nullable(Float64)')
        AS holdout_td_caught,
    JSONExtract(info, 'holdout', 'scorer_caught', 'Nullable(Float64)')
        AS holdout_scorer_caught,
    JSONExtract(info, 'holdout', 'healthy', 'Nullable(UInt8)')
        AS holdout_healthy,
    JSONExtract(info, 'days', 'training', 'Nullable(Float64)')
        AS days_training,
    JSONExtract(info, 'days', 'gaps', 'Nullable(Float64)') AS days_gaps,
    JSONExtract(info, 'days', 'unhealthy', 'Nullable(Float64)')
        AS days_unhealthy,
    JSONExtract(info, 'days', 'missing', 'Nullable(Float64)') AS days_missing,
    tupleElement(wf_total, 'ratio') AS total_ratio,
    arrayMap(m -> assumeNotNull(tupleElement(m, 'month')), wf_months)
        AS wf_month,
    arrayMap(m -> tupleElement(m, 'prs_with_events'), wf_months) AS wf_prs,
    arrayMap(m -> tupleElement(m, 'ratio'), wf_months) AS wf_ratio,
    arrayMap(m -> tupleElement(m, 'event_recall'), wf_months)
        AS wf_event_recall,
    arrayMap(m -> tupleElement(m, 'trunk_landings'), wf_months)
        AS wf_trunk_landings,
    arrayMap(m -> tupleElement(m, 'trunk_caught'), wf_months)
        AS wf_trunk_caught,
    arrayMap(m -> tupleElement(m, 'risk_auc'), wf_months) AS wf_risk_auc
FROM (
    SELECT
        rr.*,
        j.* EXCEPT (run_id),
        if(rr.report_infos = 1, rr.raw_info, '') AS info,
        JSONExtract(
            info,
            'walk_forward',
            'Array(Tuple(month Nullable(String), prs_with_events Nullable(Float64), ratio Nullable(Float64), event_recall Nullable(Float64), trunk_landings Nullable(Float64), trunk_caught Nullable(Float64), risk_auc Nullable(Float64)))'
        ) AS walk_forward,
        arrayFirst(m -> tupleElement(m, 'month') = 'total', walk_forward)
            AS wf_total,
        arrayFilter(
            m -> match(
                coalesce(tupleElement(m, 'month'), ''),
                '^[0-9][0-9][0-9][0-9]-[0-9][0-9]$'
            ),
            walk_forward
        ) AS wf_months
    FROM run_reports AS rr
    LEFT JOIN jobs AS j ON j.run_id = rr.run_id
)
ORDER BY created_at DESC, run_id DESC
SETTINGS max_execution_time = 60, max_threads = 8
