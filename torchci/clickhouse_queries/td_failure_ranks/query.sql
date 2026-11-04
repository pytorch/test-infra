-- Would TD's cut have caught each breakage on its PR? From TD's shadow ranking on main: on a main
-- push TD runs everything but still ranks HEAD^..HEAD and records every failing test file's
-- 0-based position among the job's n selected tests (td_test_failure_stats_v2). TD keeps
-- positions 0..cut, cut = 25 * n // 100. Only heads of single-commit pushes are used, so the
-- ranking is the landed PR's own diff.
--
-- A failure (head sha, config, test file; lowest position across jobs) counts when it is new: at
-- the push's `before` every shard of the config reported (success, or failure with failing tests;
-- a crashed shard leaves its files unknown) and the file did not fail; and confirmed: it fails
-- again at the first of the next three main heads where the config reported, or in two run
-- attempts at the head. config = 'workflow / job-name prefix before " / test (" / test config'
-- from workflow_job.name (the metric's build_environment differs from it for nested workflows).
--
-- The unit is a landing: a PR goes red if any one of its failures runs, so a landing is caught
-- when any failure is inside its own config's cut, and is represented by its best failure
-- (inside the cut first, then lowest rank_pct = 100 * position / n). Grains: 'hist' (landings
-- per rank-percent bucket), 'total' (always one row, also on an empty window; failures = the
-- counted failures behind those landings), 'miss' (the newest 100 landings with no failure
-- inside the cut). Columns that do not apply are 0 or empty; landed_at is 1970 outside 'miss'.
-- The window ends at most now and spans at most the metric's 90-day TTL. main_runs is read four
-- times and main_pushes three (about 0.5 s each). Measured 2026-11-04 single-threaded: 30 days
-- cost about 6 s, 90 days 21-27 s, spent on the info JSON of main runs and the evidence lookups.
WITH
least({stopTime: DateTime64(3)}, now64(3)) AS window_end,
greatest(
    {startTime: DateTime64(3)}, window_end - INTERVAL 90 DAY
) AS window_start,

main_pushes AS (
    SELECT
        head_sha,
        pushed_at,
        n_commits,
        -- Role i of a push is role_shas[i + 1]: 0 main before it, 1 its head, 2-4 the next heads.
        arrayConcat(
            [before_sha, head_sha],
            groupArray(head_sha) OVER (
                ORDER BY pushed_at ROWS BETWEEN 1 FOLLOWING AND 3 FOLLOWING
            )
        ) AS role_shas
    FROM (
        SELECT
            head_commit.id AS head_sha,
            before AS before_sha,
            toDateTime64(repository.pushed_at, 3) AS pushed_at,
            length(commits.id) AS n_commits
        FROM default.push
        PREWHERE push.ref = 'refs/heads/main'
        WHERE
            push.repository.full_name = 'pytorch/pytorch'
            -- The sort key expression verbatim; the subcolumn form reads every granule.
            AND tupleElement(head_commit, 'timestamp')
            >= window_start - INTERVAL 1 DAY
            AND tupleElement(head_commit, 'timestamp') < now64(3)
        LIMIT 1 BY head_sha
    )
),

-- Main push runs of TD workflows with TD failure records in the window. Filtering the metric on
-- these runs first means its large info column is only read where it is needed.
main_runs AS (
    SELECT
        id,
        head_sha
    FROM default.workflow_run
    WHERE
        id IN (
            SELECT run_id
            FROM misc.ossci_uploaded_metrics
            WHERE
                metric_name = 'td_test_failure_stats_v2'
                AND timestamp >= window_start
                AND timestamp < window_end
                AND pr_number = 0
                AND (
                    has({tdWorkflows: Array(String)}, workflow)
                    OR arrayExists(
                        w -> startsWith(workflow, w),
                        {tdWorkflowPrefixes: Array(String)}
                    )
                )
        )
        AND event = 'push'
        AND head_branch = 'main'
        AND head_repository.full_name = 'pytorch/pytorch'
),

evidence_shas AS (
    SELECT arrayJoin(role_shas) AS sha
    FROM main_pushes
    WHERE n_commits = 1 AND head_sha IN (SELECT head_sha FROM main_runs)
),

-- Per (sha, config): did every shard report in some attempt, and which files failed (failure or
-- error, not rerun-only) in which attempt.
evidence AS (
    SELECT
        j.head_sha AS sha,
        j.config AS config,
        max(j.num_shards) > 0
        AND uniqExactIf(
            j.shard,
            j.conclusion = 'success'
            OR (j.conclusion = 'failure' AND f.test_file != '')
        ) >= max(j.num_shards) AS completed,
        groupArrayIf(
            (f.test_file, j.run_attempt),
            j.conclusion = 'failure' AND f.test_file != ''
        ) AS fails
    FROM (
        SELECT
            id,
            head_sha,
            run_attempt,
            conclusion,
            splitByString(' / test (', name) AS name_parts,
            splitByString(', ', trimRight(name_parts[2], ')')) AS test_args,
            concat(workflow_name, ' / ', name_parts[1], ' / ', test_args[1])
                AS config,
            test_args[2] AS shard,
            toUInt32OrZero(test_args[3]) AS num_shards
        FROM default.workflow_job
        PREWHERE
            id IN (
                SELECT id FROM materialized_views.workflow_job_by_head_sha
                WHERE head_sha IN (SELECT sha FROM evidence_shas)
            )
        WHERE
            startsWith(dynamoKey, 'pytorch/pytorch/')
            AND status = 'completed'
            AND position(name, ' / test (') > 0
            AND (
                has({tdWorkflows: Array(String)}, workflow_name)
                OR arrayExists(
                    w -> startsWith(workflow_name, w),
                    {tdWorkflowPrefixes: Array(String)}
                )
            )
            AND NOT arrayExists(
                x -> position(name, x) > 0, {noTdBuildMarkers: Array(String)}
            )
        LIMIT 1 BY id
    ) AS j
    LEFT JOIN (
        SELECT DISTINCT
            job_id,
            replaceAll(invoking_file, '.', '/') AS test_file
        FROM default.failed_test_runs
        PREWHERE
            job_id IN (
                SELECT id FROM materialized_views.workflow_job_by_head_sha
                WHERE head_sha IN (SELECT sha FROM evidence_shas)
            )
        -- Array sizes only: reading the failure texts costs ten times as much.
        WHERE failure.size0 > 0 OR error.size0 > 0
    ) AS f ON j.id = f.job_id
    GROUP BY sha, config
),

-- Each TD failure record of a single-commit main push head, deduped per (sha, config, file).
candidates AS (
    SELECT
        j.head_sha AS sha,
        j.config AS config,
        m.test_file AS test_file,
        argMin((m.pos, intDiv(25 * m.n, 100), m.n), m.pos) AS best,
        groupUniqArray(m.run_attempt) AS attempts,
        any(p.pushed_at) AS landed_at,
        arrayZip(range(length(any(p.role_shas))), any(p.role_shas)) AS roles
    FROM (
        SELECT
            job_id,
            run_attempt,
            JSONExtract(
                info,
                'Tuple(selected_tests Array(String), test_name String, position Int64, max_score Float64)'
            ) AS t,
            tupleElement(t, 2) AS test_file,
            tupleElement(t, 3) AS pos,
            length(tupleElement(t, 1)) AS n,
            tupleElement(t, 4) AS max_score
        FROM misc.ossci_uploaded_metrics
        PREWHERE
            metric_name = 'td_test_failure_stats_v2'
            AND timestamp >= window_start
            AND timestamp < window_end
            AND run_id IN (SELECT id FROM main_runs)
        WHERE repo = 'pytorch/pytorch'
    ) AS m
    INNER JOIN (
        SELECT
            id,
            head_sha,
            splitByString(' / test (', name) AS name_parts,
            splitByString(', ', trimRight(name_parts[2], ')')) AS test_args,
            concat(workflow_name, ' / ', name_parts[1], ' / ', test_args[1])
                AS config
        FROM default.workflow_job
        PREWHERE
            id IN (
                SELECT job_id FROM misc.ossci_uploaded_metrics
                WHERE
                    metric_name = 'td_test_failure_stats_v2'
                    AND timestamp >= window_start
                    AND timestamp < window_end
                    AND run_id IN (SELECT id FROM main_runs)
            )
        WHERE
            position(name, ' / test (') > 0
            AND (
                has({tdWorkflows: Array(String)}, workflow_name)
                OR arrayExists(
                    w -> startsWith(workflow_name, w),
                    {tdWorkflowPrefixes: Array(String)}
                )
            )
            AND NOT arrayExists(
                x -> position(name, x) > 0, {noTdBuildMarkers: Array(String)}
            )
        LIMIT 1 BY id
    ) AS j ON m.job_id = j.id
    INNER JOIN main_pushes AS p ON j.head_sha = p.head_sha
    WHERE m.max_score > 0 AND m.n > 0 AND p.n_commits = 1
    GROUP BY sha, config, test_file
),

-- Candidates that are new and confirmed, from the evidence at every role sha.
failures AS (
    SELECT
        c.sha AS sha,
        c.config AS config,
        c.test_file AS test_file,
        any(c.landed_at) AS landed_at,
        tupleElement(any(c.best), 1) AS pos,
        tupleElement(any(c.best), 2) AS cut,
        100 * pos / tupleElement(any(c.best), 3) AS rank_pct,
        maxIf(
            e.completed
            AND NOT has(arrayMap(x -> tupleElement(x, 1), e.fails), test_file),
            c.role = 0
        ) AS before_ok,
        length(arrayDistinct(arrayConcat(
            any(c.attempts),
            arrayFlatten(groupArrayIf(
                arrayMap(
                    x -> tupleElement(x, 2),
                    arrayFilter(x -> tupleElement(x, 1) = test_file, e.fails)
                ),
                c.role = 1
            ))
        ))) AS failed_attempts,
        -- (role, failed there) at each next head where the config reported, in order.
        arraySort(groupArrayIf(
            (
                c.role,
                has(arrayMap(x -> tupleElement(x, 1), e.fails), test_file)
            ),
            c.role >= 2 AND e.completed
        )) AS nexts
    FROM (
        SELECT
            *,
            arrayJoin(roles) AS role_sha,
            tupleElement(role_sha, 1) AS role,
            tupleElement(role_sha, 2) AS ev_sha
        FROM candidates
    ) AS c
    LEFT JOIN evidence AS e ON c.ev_sha = e.sha AND c.config = e.config
    GROUP BY c.sha, c.config, c.test_file
    HAVING
        before_ok AND (failed_attempts >= 2 OR tupleElement(nexts[1], 2))
),

landings AS (
    SELECT
        sha,
        any(landed_at) AS landed_at,
        count() AS n_failures,
        argMin((pos, rank_pct, cut, config, test_file), (pos > cut, rank_pct))
            AS best,
        tupleElement(best, 1) <= tupleElement(best, 3) AS inside,
        intDiv(tupleElement(best, 3), 2) < tupleElement(best, 1) AND inside
            AS second,
        tupleElement(best, 2) AS best_rank_pct,
        least(99, toUInt8(floor(best_rank_pct))) AS bucket
    FROM failures
    GROUP BY sha
),

totals AS (
    SELECT
        bucket,
        grouping(bucket) = 1 AS is_total,
        count() AS n_landings,
        countIf(inside) AS n_inside,
        countIf(second) AS n_second,
        ifNotFinite(quantileExactInclusive(0.5) (best_rank_pct), 0)
            AS median_rank,
        sum(n_failures) AS n_failures,
        arraySlice(
            arrayReverseSort(groupArrayIf(
                (
                    'miss',
                    landed_at,
                    sha,
                    tupleElement(best, 4),
                    tupleElement(best, 5),
                    best_rank_pct
                ),
                NOT inside
            )),
            1,
            100
        ) AS misses
    FROM landings
    -- On empty input the () grouping set still returns its row.
    GROUP BY GROUPING SETS ((bucket), ())
)

SELECT
    tupleElement(out_row, 1) AS grain,
    if(grain = 'hist', bucket, 0) AS bucket_pct,
    if(grain = 'miss', 0, n_landings) AS landings,
    if(grain = 'total', n_inside, 0) AS inside_cut,
    if(grain = 'total', n_second, 0) AS second_half,
    if(grain = 'total', median_rank, 0) AS median_pct,
    if(grain = 'total', n_failures, 0) AS failures,
    tupleElement(out_row, 2) AS landed_at,
    tupleElement(out_row, 3) AS sha,
    tupleElement(out_row, 4) AS config,
    tupleElement(out_row, 5) AS test_file,
    tupleElement(out_row, 6) AS rank_pct
FROM (
    SELECT
        *,
        arrayJoin(
            if(
                is_total,
                arrayConcat(
                    [('total', toDateTime64(0, 3), '', '', '', 0.)], misses
                ),
                [('hist', toDateTime64(0, 3), '', '', '', 0.)]
            )
        ) AS out_row
    FROM totals
)
ORDER BY grain, bucket_pct, landed_at DESC, sha
SETTINGS max_execution_time = 60
