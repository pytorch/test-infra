-- noqa: disable=CP05,LT01
-- The views that fill 000004's tables, each refresh capped at 8 threads and
-- 32 GB, retried with backoff. EMPTY: no refresh at creation; the first runs
-- at the next slot. Days older than the 4-day window are filled once by
-- hand (same queries, fixed dates).

-- Every 3 hours: the jobs that started today so far and in the 3 days before,
-- so a report up to about 3 days late, or a failed refresh, is caught by a
-- later one. Reads ci.runs, ci.tests, ci.owners, ci.env_vars and
-- default.workflow_job; writes cost_job_facts.
CREATE MATERIALIZED VIEW cost_job_facts_mv
REFRESH EVERY 3 HOUR OFFSET 30 MINUTE
SETTINGS refresh_retries = 3, refresh_retry_initial_backoff_ms = 30000,
    refresh_retry_max_backoff_ms = 300000
APPEND TO cost_job_facts
EMPTY
AS
WITH
    -- Completed jobs that started in the range, every repository, with their
    -- runner windows in milliseconds.
    jobs AS (
        SELECT
            id,
            toDate(started_at) AS day,
            toUnixTimestamp64Milli(toDateTime64(started_at, 3)) AS job_start,
            toUnixTimestamp64Milli(toDateTime64(completed_at, 3)) AS job_end
        FROM default.workflow_job
        WHERE status = 'completed'
            AND conclusion NOT IN ('skipped', '')
            AND runner_name != ''
            AND started_at >= today() - 3 AND started_at < today() + 1
            AND started_at >= created_at
            AND dateDiff('second', started_at, completed_at) BETWEEN 0 AND 86400
    ),
    -- Each report's span and test seconds, by file.
    file_spans AS (
        SELECT
            r.github_workflow_job_id AS job_id,
            r.report_uuid AS report,
            t.repo AS repo,
            t.file AS file,
            min(toUnixTimestamp64Milli(r.started_at)) AS span_start,
            max(toUnixTimestamp64Milli(r.ended_at)) AS span_end,
            any(r.environments_id) AS environments_id,
            any(r.env_vars_id) AS env_vars_id,
            sum(greatest(0, dateDiff('millisecond', r.started_at, r.ended_at))) / 1000 AS seconds
        FROM ci.runs AS r FINAL
        INNER JOIN (SELECT id, repo, file FROM ci.tests FINAL) AS t ON t.id = r.tests_id
        WHERE toDate(r.started_at) >= today() - 3 AND toDate(r.started_at) <= today() + 1
            AND r.outcome != 'skipped'
            AND r.github_workflow_job_id IN (SELECT id FROM jobs)
        GROUP BY job_id, report, repo, file
    ),
    -- Each report's span and test seconds by owner.
    report_spans AS (
        SELECT
            job_id,
            report,
            any(repo) AS repo,
            min(span_start) AS span_start,
            max(span_end) AS span_end,
            any(environments_id) AS environments_id,
            any(test_config) AS test_config,
            mapFromArrays(groupArray(owner), groupArray(seconds)) AS owner_seconds
        FROM (
            SELECT
                f.job_id AS job_id,
                f.report AS report,
                f.repo AS repo,
                arrayJoin(if(empty(o.owners), [''], o.owners)) AS owner,
                min(f.span_start) AS span_start,
                max(f.span_end) AS span_end,
                any(f.environments_id) AS environments_id,
                any(ev.test_config) AS test_config,
                sum(f.seconds / greatest(length(o.owners), 1)) AS seconds
            FROM file_spans AS f
            LEFT JOIN (SELECT repo, file, owners FROM ci.owners FINAL) AS o
                ON o.repo = f.repo AND o.file = f.file
            LEFT JOIN (SELECT id, env_vars['TEST_CONFIG'] AS test_config FROM ci.env_vars FINAL) AS ev
                ON ev.id = f.env_vars_id
            GROUP BY job_id, report, f.repo, owner
        )
        GROUP BY job_id, report
    ),
    -- Each job's reports as (start, end, owner seconds), clipped to the job.
    job_spans AS (
        SELECT
            j.day AS day,
            s.job_id AS job_id,
            any(s.repo) AS repo,
            any(s.environments_id) AS environments_id,
            any(s.test_config) AS test_config,
            toUInt32(count()) AS reports,
            arrayFilter(
                x -> x.2 > x.1 AND arraySum(mapValues(x.3)) > 0,
                groupArray((greatest(s.span_start, j.job_start), least(s.span_end, j.job_end), s.owner_seconds))
            ) AS spans
        FROM report_spans AS s
        INNER JOIN jobs AS j ON j.id = s.job_id
        GROUP BY day, job_id
    ),
    -- The sweep, in O(R log R) time and O(R) memory per job (no lambda indexes
    -- into another array): span starts and ends in time order, tagged with the
    -- span's index; the reports running during each stretch between events;
    -- the time held by one report up to each event; then each span's held time
    -- as that value at its end minus at its start.
    swept AS (
        SELECT
            day, job_id, repo, environments_id, test_config, reports, spans,
            arraySort(arrayFlatten(arrayMap(
                (x, i) -> [(x.1, 1, i), (x.2, -1, i)], spans, arrayEnumerate(spans)))) AS events,
            arrayMap(x -> x.1, events) AS times,
            arrayPopBack(arrayCumSum(arrayMap(x -> x.2, events))) AS running,
            arraySum(arrayMap(
                (a, b, n) -> if(n > 0, b - a, 0),
                arrayPopBack(times), arrayPopFront(times), running)) / 1000 AS busy_seconds,
            arrayPushFront(arrayCumSum(arrayMap(
                (a, b, n) -> if(n > 0, (b - a) / n, 0),
                arrayPopBack(times), arrayPopFront(times), running)), 0) AS held_upto,
            -- held_upto regrouped by span: its start, then its end
            arraySort((h, e) -> (e.3, -e.2), held_upto, events) AS by_span,
            arrayMap(
                (a, b) -> (b - a) / 1000,
                arrayFilter((h, k) -> k % 2 = 1, by_span, arrayEnumerate(by_span)),
                arrayFilter((h, k) -> k % 2 = 0, by_span, arrayEnumerate(by_span))) AS held
        FROM job_spans
        WHERE length(spans) > 0
    )
SELECT
    day,
    job_id AS github_workflow_job_id,
    any(repo) AS repo,
    any(environments_id) AS environments_id,
    any(test_config) AS test_config,
    sumMap(span.3) AS owner_test_seconds,
    sumMap(mapApply((k, v) -> (k, span_held * v / arraySum(mapValues(span.3))), span.3)) AS owner_held_seconds,
    any(busy_seconds) AS busy_seconds,
    any(reports) AS reports,
    now64(3, 'UTC') AS computed_at
FROM (
    -- Only the spans and per-job values, so unrolling them stays O(R).
    SELECT day, job_id, repo, environments_id, test_config, reports, busy_seconds, spans, held
    FROM swept
)
ARRAY JOIN spans AS span, held AS span_held
GROUP BY day, job_id
SETTINGS join_use_nulls = 0, max_threads = 8, max_memory_usage = 32000000000;

-- Runs after cost_job_facts_mv in the same time slot (ClickHouse may skip a
-- slot and does not promise exactly one run per facts refresh): the same
-- days, every completed job of every repository. Today and yesterday are
-- provisional (jobs still running, reports still arriving).
CREATE MATERIALIZED VIEW cost_daily_mv
REFRESH EVERY 3 HOUR OFFSET 30 MINUTE
DEPENDS ON cost_job_facts_mv
SETTINGS refresh_retries = 3, refresh_retry_initial_backoff_ms = 30000,
    refresh_retry_max_backoff_ms = 300000
APPEND TO cost_daily
EMPTY
AS
WITH
    -- Completed jobs that ran on a runner, as the cost API counts them
    -- (lib/api/tests/cost/query.ts, COMPLETED_JOBS).
    jobs AS (
        SELECT
            id,
            toDate(started_at) AS day,
            repository_full_name AS repo,
            lower(workflow_name) AS workflow,
            arrayStringConcat(labels, ',') AS label,
            multiIf(
                match(name, '(?:^|/ )test \\('), 'test',
                positionCaseInsensitive(name, 'build') > 0, 'build',
                'other'
            ) AS name_kind,
            dateDiff('millisecond', started_at, completed_at) / 3.6e6 AS hours
        FROM default.workflow_job
        WHERE status = 'completed'
            AND conclusion NOT IN ('skipped', '')
            AND runner_name != ''
            AND started_at >= today() - 3 AND started_at < today() + 1
            AND started_at >= created_at
            AND dateDiff('second', started_at, completed_at) BETWEEN 0 AND 86400
    ),
    facts AS (
        SELECT
            github_workflow_job_id AS job_id,
            environments_id,
            test_config,
            owner_test_seconds,
            owner_held_seconds,
            busy_seconds
        FROM cost_job_facts FINAL
        WHERE day >= today() - 3 AND day < today() + 1
    ),
    job_rows AS (
        SELECT
            j.day AS day,
            j.repo AS repo,
            j.workflow AS workflow,
            j.label AS label,
            j.name_kind AS name_kind,
            j.hours AS hours,
            f.job_id != 0 AND f.busy_seconds > 0 AS reported,
            f.test_config AS test_config,
            f.owner_test_seconds AS owner_test_seconds,
            f.owner_held_seconds AS owner_held_seconds,
            f.busy_seconds AS busy_seconds,
            (e.device_name, e.device_count, e.accelerator, e.os, e.cpu_architecture, e.cpu_capability) AS machine
        FROM jobs AS j
        LEFT JOIN facts AS f ON f.job_id = j.id
        LEFT JOIN (
            SELECT id, device_name, device_count, accelerator, os, cpu_architecture, cpu_capability
            FROM ci.environments FINAL
        ) AS e ON e.id = f.environments_id
    ),
    -- Each runner label's machine on a day: the one most of its reporting
    -- jobs ran on, for the label's jobs that did not report.
    label_machines AS (
        SELECT day, label, argMax(machine, jobs) AS machine
        FROM (
            SELECT day, label, machine, count() AS jobs
            FROM job_rows
            WHERE reported
            GROUP BY day, label, machine
        )
        GROUP BY day, label
    )
SELECT
    day,
    repo,
    workflow,
    test_config,
    tupleElement(share, 1) AS owner,
    tupleElement(m, 1) AS device_name,
    tupleElement(m, 2) AS device_count,
    tupleElement(m, 3) AS accelerator,
    tupleElement(m, 4) AS os,
    tupleElement(m, 5) AS cpu_architecture,
    tupleElement(m, 6) AS cpu_capability,
    machine_source,
    label,
    sum(tupleElement(share, 2)) AS runner_hours,
    sum(tupleElement(share, 3)) AS overhead_hours,
    sum(tupleElement(share, 4)) AS test_hours,
    sum(tupleElement(share, 5)) AS test_ratio_hours,
    now64(3, 'UTC') AS computed_at
FROM (
    SELECT
        r.day AS day,
        r.repo AS repo,
        r.workflow AS workflow,
        if(r.reported, r.test_config, '') AS test_config,
        r.label AS label,
        if(r.reported, r.machine, lm.machine) AS m,
        multiIf(r.reported, 'job', lm.label != '', 'label', '') AS machine_source,
        -- (owner, runner hours, overhead hours, test hours, test-ratio hours)
        arrayJoin(multiIf(
            r.reported,
                arrayMap(
                    k -> (
                        if(k = '', 'unattributed:no_owner', k),
                        r.hours * r.owner_held_seconds[k] / held_total,
                        greatest(0., r.hours - r.busy_seconds / 3600) * r.owner_held_seconds[k] / held_total,
                        r.owner_test_seconds[k] / 3600,
                        r.hours * r.owner_test_seconds[k] / test_total
                    ),
                    mapKeys(r.owner_held_seconds)
                ),
            r.name_kind = 'test',
                [('unattributed:no_test_reports', r.hours, 0., 0., r.hours)],
            r.name_kind = 'build', [('shared:build', r.hours, 0., 0., r.hours)],
            [('shared:other', r.hours, 0., 0., r.hours)]
        )) AS share
    FROM (
        SELECT
            *,
            arraySum(mapValues(owner_held_seconds)) AS held_total,
            arraySum(mapValues(owner_test_seconds)) AS test_total
        FROM job_rows
    ) AS r
    LEFT JOIN label_machines AS lm ON lm.day = r.day AND lm.label = r.label
)
GROUP BY
    day, repo, workflow, test_config, owner, device_name, device_count, accelerator,
    os, cpu_architecture, cpu_capability, machine_source, label
SETTINGS join_use_nulls = 0, max_threads = 8, max_memory_usage = 32000000000;
