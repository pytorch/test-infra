-- Where TD ranked the test files that failed, from its record of each failure
-- (td_test_failure_stats_v2: the file's 0-based position among the job's n selected tests). TD
-- keeps positions 0..cut, cut = 25 * n // 100. Deduped per (head sha, config, test file) at the
-- lowest position; config = 'workflow / job-name prefix before " / test (" / test config' from
-- workflow_job.name (the metric's build_environment differs from it for nested workflows).
--   * trunk_new: TD's shadow ranking on main, where it runs everything but still ranks
--     HEAD^..HEAD: heads of single-commit pushes, so the landed PR's own diff. Kept when new (at
--     the push's `before` every shard of the config reported and the file did not fail) and
--     confirmed (it fails again at the first of the next three main heads where the config
--     reported, or in two run attempts at the head). rank_pct = 100 * position / n.
--   * pr_order: PR runs (pull_request, ciflow tags), inside the cut. A PR job stops at its first
--     failing file, so this shows ordering only. rank_pct = 100 * position / (cut + 1).
-- Grains: 'hist' (per population and rank-percent bucket), 'total' (one per population, also on
-- an empty window), 'miss' (the newest 100 trunk_new failures outside the cut). Columns that do
-- not apply are 0 or empty; landed_at is 1970 outside 'miss'. The window ends at most now and
-- spans at most the metric's 90-day TTL. main_pushes is read three times (about 0.5 s each).
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

evidence_shas AS (
    SELECT arrayJoin(role_shas) AS sha
    FROM main_pushes
    WHERE
        n_commits = 1
        AND head_sha IN (
            SELECT head_sha FROM default.workflow_run
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
        )
),

-- Per (sha, config): did every shard report in some attempt (success, or failure with failing
-- tests; a crashed shard leaves its files unknown), and which files failed in which attempt.
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

-- One row per TD failure record, joined to its job and run. The metric's workflow filter only
-- prunes the scan of its large info column; the job's workflow decides.
failure_rows AS (
    SELECT
        j.head_sha AS sha,
        j.config AS config,
        m.test_file AS test_file,
        m.pos AS pos,
        m.n AS n,
        m.run_attempt AS run_attempt,
        intDiv(25 * m.n, 100) AS cut,
        multiIf(
            r.is_main AND p.n_commits = 1, 'trunk_new',
            r.is_pr AND m.pos <= cut, 'pr_order',
            ''
        ) AS population,
        p.pushed_at AS landed_at,
        if(
            population = 'trunk_new',
            arrayZip(range(length(p.role_shas)), p.role_shas),
            [(0, '')]
        ) AS roles
    FROM (
        SELECT
            job_id,
            run_id,
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
        WHERE
            metric_name = 'td_test_failure_stats_v2'
            AND timestamp >= window_start
            AND timestamp < window_end
            AND repo = 'pytorch/pytorch'
            AND (
                has({tdWorkflows: Array(String)}, workflow)
                OR arrayExists(
                    w -> startsWith(workflow, w),
                    {tdWorkflowPrefixes: Array(String)}
                )
            )
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
    INNER JOIN (
        SELECT
            id,
            event = 'push'
            AND head_branch = 'main'
            AND head_repository.full_name = 'pytorch/pytorch' AS is_main,
            event = 'pull_request' OR head_branch LIKE 'ciflow/%' AS is_pr
        FROM default.workflow_run
        WHERE
            id IN (
                SELECT run_id FROM misc.ossci_uploaded_metrics
                WHERE
                    metric_name = 'td_test_failure_stats_v2'
                    AND timestamp >= window_start
                    AND timestamp < window_end
            )
        LIMIT 1 BY id
    ) AS r ON m.run_id = r.id
    LEFT JOIN main_pushes AS p ON j.head_sha = p.head_sha
    WHERE m.max_score > 0 AND m.n > 0 AND population != ''
),

candidates AS (
    SELECT
        population,
        sha,
        config,
        test_file,
        argMin((pos, cut, n), pos) AS best,
        groupUniqArray(run_attempt) AS attempts,
        any(landed_at) AS cand_landed_at,
        any(roles) AS cand_roles
    FROM failure_rows
    GROUP BY population, sha, config, test_file
),

-- Each candidate with the evidence at every role sha. A trunk_new candidate is kept when it is
-- new and confirmed; a pr_order candidate (one role, no sha) always.
verdicts AS (
    SELECT
        c.population AS population,
        c.sha AS sha,
        c.config AS config,
        c.test_file AS test_file,
        any(c.cand_landed_at) AS landed_at,
        tupleElement(any(c.best), 1) AS pos,
        tupleElement(any(c.best), 2) AS cut,
        if(
            population = 'trunk_new',
            100 * pos / tupleElement(any(c.best), 3),
            100 * pos / (cut + 1)
        ) AS rank_pct,
        pos <= cut AS inside,
        if(
            population = 'trunk_new',
            intDiv(cut, 2) < pos AND pos <= cut,
            rank_pct >= 50
        ) AS second,
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
            arrayJoin(cand_roles) AS role_sha,
            tupleElement(role_sha, 1) AS role,
            tupleElement(role_sha, 2) AS ev_sha
        FROM candidates
    ) AS c
    LEFT JOIN evidence AS e ON c.ev_sha = e.sha AND c.config = e.config
    GROUP BY c.population, c.sha, c.config, c.test_file
    HAVING
        population = 'pr_order'
        OR (
            before_ok
            AND (failed_attempts >= 2 OR tupleElement(nexts[1], 2))
        )
),

totals AS (
    SELECT
        population,
        bucket,
        grouping(bucket) = 1 AS is_total,
        countIf(NOT dummy) AS n_failures,
        countIf(NOT dummy AND inside) AS n_inside,
        countIf(NOT dummy AND second) AS n_second,
        ifNotFinite(
            quantileExactInclusiveIf(0.5) (rank_pct, NOT dummy), 0
        ) AS median_rank,
        arraySlice(
            arrayReverseSort(groupArrayIf(
                miss_row,
                NOT dummy AND NOT inside AND population = 'trunk_new'
            )),
            1,
            100
        ) AS misses
    FROM (
        SELECT
            population,
            ('miss', landed_at, sha, config, test_file, rank_pct) AS miss_row,
            rank_pct,
            inside,
            second,
            false AS dummy,
            least(99, toUInt8(floor(rank_pct))) AS bucket
        FROM verdicts
        UNION ALL
        -- One placeholder per population, so both total rows exist on any window.
        SELECT
            arrayJoin(['trunk_new', 'pr_order']) AS population,
            ('miss', toDateTime64(0, 3), '', '', '', 0.) AS miss_row,
            0. AS rank_pct,
            false AS inside,
            false AS second,
            true AS dummy,
            toUInt8(0) AS bucket
    )
    GROUP BY GROUPING SETS ((population, bucket), (population))
)

SELECT
    tupleElement(out_row, 1) AS grain,
    population,
    if(grain = 'hist', bucket, 0) AS bucket_pct,
    if(grain = 'miss', 0, n_failures) AS failures,
    if(grain = 'total', n_inside, 0) AS inside_cut,
    if(grain = 'total', n_second, 0) AS second_half,
    if(grain = 'total', median_rank, 0) AS median_pct,
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
    WHERE is_total OR n_failures > 0
)
ORDER BY grain, population, bucket_pct, landed_at DESC, sha, config, test_file
SETTINGS max_execution_time = 60
