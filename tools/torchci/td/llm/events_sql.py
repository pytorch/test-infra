"""The ClickHouse queries of the event snapshot (events.py runs them).

Every query is read-only (`readonly = 2`) and bounded in time and threads; values are
bound as parameters, never interpolated.
"""

RETENTION_DAYS = 90
SETTINGS = "SETTINGS readonly = 2, max_execution_time = 120, max_threads = 8"

# The workflows pytorch's run_test.py enables TD in (its `--enable-td` default).
TD_WORKFLOWS = ("pull", "trunk")
TD_WORKFLOW_PREFIXES = ("rocm-", "periodic-rocm-")
TD_SCOPE = (
    f"(workflow IN ({', '.join(repr(w) for w in TD_WORKFLOWS)})"
    + "".join(f" OR startsWith(workflow, {p!r})" for p in TD_WORKFLOW_PREFIXES)
    + ")"
)
RANK_COLUMNS = (
    "run_id, job_id, workflow, build_environment, test_config, timestamp, info,"
    " JSONExtractString(info, 'test_name') AS test_file"
)
METRIC_FILTER = (
    "metric_name = 'td_test_failure_stats_v2' AND repo = 'pytorch/pytorch' AND "
    + TD_SCOPE
)

E2_SQL = f"""
WITH
    greatest({{start: DateTime64(3)}},
        now64(3) - toIntervalDay({{look_back_days: UInt32}})) AS w0,
    least({{stop: DateTime64(3)}}, now64(3)) AS w1,
    {{main_window: UInt32}} AS main_window_s,
    metric_rows AS (
        SELECT pr_number, {RANK_COLUMNS} FROM misc.ossci_uploaded_metrics
        WHERE {METRIC_FILTER}
            AND timestamp >= w0 - toIntervalSecond(main_window_s)
            AND timestamp < w1 + toIntervalSecond(main_window_s)
    ),
    runs AS (
        SELECT id, head_sha, head_branch, pull_requests FROM default.workflow_run
        WHERE id IN (SELECT run_id FROM metric_rows) LIMIT 1 BY id
    ),
    tagged AS (
        SELECT m.*, w.head_branch AS head_branch,
            if(m.pr_number > 0, 'pull_request', 'ciflow_tag') AS pr_source,
            if(m.pr_number > 0, m.pr_number,
                toInt64OrZero(extract(w.head_branch, '^ciflow/[^/]+/(\\\\d+)$'))) AS pr
        FROM metric_rows AS m
        LEFT JOIN (SELECT id, head_branch FROM runs) AS w ON w.id = m.run_id
    ),
    nonpr AS (
        SELECT test_file, groupArray(tuple(timestamp, head_branch)) AS hits
        FROM tagged WHERE pr = 0 GROUP BY test_file
    ),
    firsts AS (
        SELECT pr, test_file, min(timestamp) AS failed_at,
            argMin(tuple(run_id, job_id, workflow, build_environment, test_config,
                JSONExtractInt(info, 'position'), JSONLength(info, 'selected_tests'),
                JSONExtractFloat(info, 'max_score'), JSONExtractRaw(info, 'all_scores'),
                pr_source), tuple(timestamp, job_id)) AS r
        FROM tagged WHERE pr > 0 AND timestamp >= w0 AND timestamp < w1
        GROUP BY pr, test_file
    ),
    head_bases AS (
        SELECT w.head_sha AS head_sha, p.number AS pr, any(p.base.sha) AS base_sha
        FROM default.workflow_run AS w ARRAY JOIN w.pull_requests AS p
        WHERE w.id IN (
            SELECT id FROM materialized_views.workflow_run_by_head_sha WHERE head_sha IN
                (SELECT head_sha FROM runs WHERE startsWith(head_branch, 'ciflow/'))
        ) AND w.event = 'pull_request'
        GROUP BY head_sha, pr
    )
SELECT
    f.pr AS pr_number, f.test_file AS test_file, f.failed_at AS failed_at,
    f.r.1 AS run_id, f.r.2 AS job_id, f.r.3 AS workflow, f.r.4 AS build_environment,
    f.r.5 AS test_config, f.r.6 AS position, f.r.7 AS n, f.r.8 AS max_score,
    f.r.9 AS all_scores, f.r.10 AS pr_source, w.head_sha AS head_sha,
    arrayFirst(p -> tupleElement(p, 'number') = f.pr, w.pull_requests).base.sha
        AS pr_base_sha, hb.base_sha AS head_pr_base_sha, mb.merge_base AS merge_base,
    arrayDistinct(arrayMap(x -> tupleElement(x, 2), arrayFilter(x -> abs(dateDiff(
        'second', tupleElement(x, 1), f.failed_at)) <= main_window_s, n.hits)))
        AS nonpr_branches
FROM firsts AS f
LEFT JOIN runs AS w ON w.id = f.r.1
LEFT JOIN head_bases AS hb ON hb.head_sha = w.head_sha AND hb.pr = f.pr
LEFT JOIN (
    SELECT sha, any(merge_base) AS merge_base FROM default.merge_bases
    WHERE repo = 'pytorch/pytorch' AND sha IN (SELECT head_sha FROM runs) GROUP BY sha
) AS mb ON mb.sha = w.head_sha
LEFT JOIN nonpr AS n ON n.test_file = f.test_file
ORDER BY failed_at, pr_number, test_file
{SETTINGS}
"""

E1_RANKINGS_SQL = f"""
WITH runs AS (
    SELECT id, head_sha FROM default.workflow_run
    WHERE id IN (
        SELECT id FROM materialized_views.workflow_run_by_head_sha
        WHERE head_sha IN arrayDistinct({{shas: Array(String)}})
    ) AND repository.full_name = 'pytorch/pytorch'
    LIMIT 1 BY id
)
SELECT
    w.head_sha AS landing_sha, m.run_id AS run_id, m.job_id AS job_id,
    m.workflow AS workflow, m.build_environment AS build_environment,
    m.test_config AS test_config, m.timestamp AS timestamp, m.test_file AS test_file,
    JSONExtractInt(m.info, 'position') AS position,
    JSONExtractFloat(m.info, 'max_score') AS max_score,
    JSONExtractRaw(m.info, 'all_scores') AS all_scores
FROM (
    SELECT {RANK_COLUMNS} FROM misc.ossci_uploaded_metrics
    WHERE {METRIC_FILTER} AND pr_number = 0 AND run_id IN (SELECT id FROM runs)
        AND timestamp >= {{start: DateTime64(3)}} AND timestamp < {{stop: DateTime64(3)}}
) AS m
INNER JOIN runs AS w ON w.id = m.run_id
WHERE (w.head_sha, m.test_file) IN (
    SELECT tupleElement(p, 1), tupleElement(p, 2)
    FROM (SELECT arrayJoin(arrayZip({{shas: Array(String)}}, {{files: Array(String)}})) AS p)
)
ORDER BY landing_sha, timestamp, job_id
{SETTINGS}
"""
