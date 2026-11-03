-- noqa: disable=CP05,LT01
-- Every 3 hours, recompute test_cost (000004) for the jobs that started today
-- and in the 3 days before, so reports up to 3 days late land. Days older
-- than that are filled once by hand, while ci.runs still holds them: the same
-- query with fixed dates, inserted into test_cost. Reads ci.runs, ci.tests,
-- ci.owners and default.workflow_job.
CREATE MATERIALIZED VIEW test_cost_mv
REFRESH EVERY 3 HOUR OFFSET 30 MINUTE
SETTINGS refresh_retries = 3, refresh_retry_initial_backoff_ms = 30000,
    refresh_retry_max_backoff_ms = 300000
APPEND TO test_cost
AS
WITH
    -- Completed jobs that started in the window, every repository, as the
    -- cost API counts them (lib/api/tests/cost/query.ts, COMPLETED_JOBS):
    -- the latest version of each, with its runner window in milliseconds.
    -- Only days ci.runs still holds in full (its first day may be partly
    -- expired): computing a day after ci.runs dropped it would find jobs but
    -- no runs, and that computation would replace the day's real one.
    jobs AS (
        SELECT
            id,
            toDate(started_at) AS day,
            repository_full_name AS repo,
            lower(workflow_name) AS workflow_name,
            arrayStringConcat(arraySort(labels), ',') AS runner_labels,
            match(name, '(?:^|/ )test \\(') AS is_test_job,
            toUnixTimestamp64Milli(toDateTime64(started_at, 3)) AS job_start,
            toUnixTimestamp64Milli(toDateTime64(completed_at, 3)) AS job_end
        FROM (
            SELECT
                id, repository_full_name, workflow_name, labels, name, status, conclusion,
                runner_name, created_at, started_at, completed_at
            FROM default.workflow_job
            WHERE started_at >= today() - 3 AND started_at < today() + 1
                AND started_at >= (SELECT toDate(min(started_at)) + 1 FROM ci.runs)
            ORDER BY _inserted_at DESC
            LIMIT 1 BY id
        )
        WHERE status = 'completed'
            AND conclusion NOT IN ('skipped', '')
            AND runner_name != ''
            AND started_at >= created_at
            AND dateDiff('second', started_at, completed_at) BETWEEN 0 AND 86400
    ),
    -- Each report's runs on each test file and module (the gtest suite for
    -- C++ tests, '' for Python): first start, last end, executed and skipped
    -- time.
    module_runs AS (
        SELECT
            r.github_workflow_job_id AS job_id,
            r.report_uuid AS report_uuid,
            t.file AS test_file,
            if(t.language = 'cpp', t.suite, '') AS test_module,
            min(toUnixTimestamp64Milli(r.started_at)) AS first_start,
            max(toUnixTimestamp64Milli(r.ended_at)) AS last_end,
            any(r.environments_id) AS environments_id,
            sumIf(greatest(0, dateDiff('millisecond', r.started_at, r.ended_at)), r.outcome != 'skipped') / 1000
                AS executed_test_seconds,
            sumIf(greatest(0, dateDiff('millisecond', r.started_at, r.ended_at)), r.outcome = 'skipped') / 1000
                AS skipped_test_seconds
        FROM ci.runs AS r FINAL
        INNER JOIN (SELECT id, file, suite, language FROM ci.tests FINAL) AS t ON t.id = r.tests_id
        WHERE toDate(r.started_at) >= today() - 3 AND toDate(r.started_at) <= today() + 1
            AND r.github_workflow_job_id IN (SELECT id FROM jobs)
        GROUP BY job_id, report_uuid, test_file, test_module
    ),
    -- Each job's spans, one per report and file: its runs' first start to
    -- last end, skipped runs included, clipped to the job, as (start, end,
    -- file, environment, [(module, executed, skipped)]).
    job_file_spans AS (
        SELECT job_id, groupArray((span_start, span_end, test_file, environments_id, modules)) AS spans
        FROM (
            SELECT
                m.job_id AS job_id,
                greatest(min(m.first_start), any(j.job_start)) AS span_start,
                least(max(m.last_end), any(j.job_end)) AS span_end,
                toString(m.test_file) AS test_file,
                any(m.environments_id) AS environments_id,
                groupArray((toString(m.test_module), m.executed_test_seconds, m.skipped_test_seconds)) AS modules
            FROM module_runs AS m
            INNER JOIN jobs AS j ON j.id = m.job_id
            GROUP BY m.job_id, m.report_uuid, m.test_file
        )
        GROUP BY job_id
    ),
    -- Every job in the window with its non-empty spans ([] without reports).
    job_spans AS (
        SELECT
            j.id AS job_id,
            j.day AS day,
            j.repo AS repo,
            j.workflow_name AS workflow_name,
            j.runner_labels AS runner_labels,
            j.is_test_job AS is_test_job,
            (j.job_end - j.job_start) / 1000 AS wall_seconds,
            arrayFilter(x -> x.2 > x.1, f.spans) AS spans
        FROM jobs AS j
        LEFT JOIN job_file_spans AS f ON f.job_id = j.id
    ),
    -- The sweep, in O(S log S) time and O(S) memory per job: span starts and
    -- ends in time order, tagged with the span's index; the spans running
    -- during each stretch between events; the time held by one span up to
    -- each event; then each span's held time as that value at its end minus
    -- at its start. A job without spans holds nothing.
    swept AS (
        SELECT
            day, job_id, repo, workflow_name, runner_labels, is_test_job, wall_seconds, spans,
            arraySort(arrayFlatten(arrayMap(
                (x, i) -> [(x.1, 1, i), (x.2, -1, i)], spans, arrayEnumerate(spans)))) AS events,
            arrayMap(x -> x.1, events) AS times,
            arrayPopBack(arrayCumSum(arrayMap(x -> x.2, events))) AS running,
            if(empty(events), emptyArrayFloat64(), arrayPushFront(arrayCumSum(arrayMap(
                (a, b, n) -> if(n > 0, (b - a) / n, 0),
                arrayPopBack(times), arrayPopFront(times), running)), 0)) AS held_upto,
            -- held_upto regrouped by span: its start, then its end
            arraySort((h, e) -> (e.3, -e.2), held_upto, events) AS by_span,
            arrayMap(
                (a, b) -> (b - a) / 1000,
                arrayFilter((h, k) -> k % 2 = 1, by_span, arrayEnumerate(by_span)),
                arrayFilter((h, k) -> k % 2 = 0, by_span, arrayEnumerate(by_span))) AS held,
            -- The job's busy time (its spans' held time adds up to it) and
            -- test time, executed and skipped runs both.
            arraySum(held) AS busy_seconds,
            arraySum(arrayMap(x -> arraySum(arrayMap(m -> m.2 + m.3, x.5)), spans)) AS job_test_seconds
        FROM job_spans
    ),
    -- One row per job, file and module as (file, module, environment,
    -- executed, skipped, held), a span's held time split among its modules
    -- by run time (evenly if it has none); a test job without spans is one
    -- ('', '', 0, 0, 0, 0) row, other jobs without spans none.
    job_rows AS (
        SELECT
            day, repo, workflow_name, runner_labels, wall_seconds, busy_seconds, job_test_seconds,
            if(empty(spans),
                if(is_test_job, [('', '', toUInt64(0), 0., 0., 0.)], []),
                arrayFlatten(arrayMap(
                    (x, h) -> arrayMap(
                        m -> (x.3, m.1, x.4, m.2, m.3,
                            h * if(arraySum(arrayMap(k -> k.2 + k.3, x.5)) > 0,
                                (m.2 + m.3) / arraySum(arrayMap(k -> k.2 + k.3, x.5)),
                                1 / length(x.5))),
                        x.5),
                    spans, held))) AS rows
        FROM swept
    ),
    -- Owners by (file, module), then by file. C++ owners by (file, module)
    -- join here once a source for them exists.
    owners_by_key AS (
        SELECT repo, file, '' AS module, owners FROM ci.owners FINAL
    )
SELECT
    g.day AS day,
    g.repo AS repo,
    g.workflow_name AS workflow_name,
    g.test_file AS test_file,
    g.test_module AS test_module,
    g.environments_id AS environments_id,
    g.runner_labels AS runner_labels,
    multiIf(notEmpty(owner_module.owners), owner_module.owners, notEmpty(owner_file.owners), owner_file.owners, [])
        AS owners_snapshot,
    g.executed_test_seconds AS executed_test_seconds,
    g.skipped_test_seconds AS skipped_test_seconds,
    g.held_seconds AS held_seconds,
    g.occupancy_runner_seconds AS occupancy_runner_seconds,
    g.test_ratio_runner_seconds AS test_ratio_runner_seconds,
    now64(3, 'UTC') AS computed_at
FROM (
    SELECT
        day, repo, workflow_name, test_file, test_module, environments_id, runner_labels,
        sum(executed) AS executed_test_seconds,
        sum(skipped) AS skipped_test_seconds,
        sum(held) AS held_seconds,
        sum(occupancy) AS occupancy_runner_seconds,
        sum(test_ratio) AS test_ratio_runner_seconds
    FROM (
        -- Each row's share of its job's wall time: by occupancy (held over
        -- busy time) and by test-time ratio (test time, executed and skipped,
        -- over the job's, or by occupancy when its runs took no time). A test
        -- job without spans keeps its whole wall time either way.
        SELECT
            day, repo, workflow_name, runner_labels,
            row.1 AS test_file,
            row.2 AS test_module,
            row.3 AS environments_id,
            row.4 AS executed,
            row.5 AS skipped,
            row.6 AS held,
            if(busy_seconds > 0, wall_seconds * row.6 / busy_seconds, wall_seconds) AS occupancy,
            multiIf(busy_seconds = 0, wall_seconds,
                job_test_seconds > 0, wall_seconds * (row.4 + row.5) / job_test_seconds,
                wall_seconds * row.6 / busy_seconds) AS test_ratio
        FROM (
            -- Only the rows and per-job values, so unrolling them stays O(S).
            SELECT day, repo, workflow_name, runner_labels, wall_seconds, busy_seconds, job_test_seconds, rows
            FROM job_rows
        )
        ARRAY JOIN rows AS row
    )
    GROUP BY day, repo, workflow_name, test_file, test_module, environments_id, runner_labels
) AS g
LEFT JOIN owners_by_key AS owner_module
    ON owner_module.repo = g.repo AND owner_module.file = g.test_file AND owner_module.module = g.test_module
LEFT JOIN (SELECT repo, file, owners FROM owners_by_key WHERE module = '') AS owner_file
    ON owner_file.repo = g.repo AND owner_file.file = g.test_file
SETTINGS join_use_nulls = 0, do_not_merge_across_partitions_select_final = 1, max_threads = 8,
    max_memory_usage = 32000000000, max_execution_time = 1800;
