-- How much TD's picks change between consecutive pushes of the same pytorch/pytorch PR. For each
-- (PR, config, head sha) of a `pull` run (pull_request event or ciflow tag push):
-- the set of test files that ran across all shards (test_run_summary), only when the latest
-- attempt of every shard concluded success and reported test files. A run's jobs count when they
-- were created within a day of the run, so a re-run started later is not seen. A set counts as
-- TD-on when it holds at most half the median file count of that config's green sets on main
-- pushes in the span the sets are read from; TD-off sets and configs without a main baseline are
-- dropped. Pairs are consecutive remaining head shas of a PR and config, ordered by run creation;
-- a pair counts when its later run was created in the window and its earlier run at most 14 days
-- before that, so sets are read from 14 days before the window. Identical when the sets are equal,
-- change = 100 * (1 - |A and B| / |A or B|) otherwise.
--
-- A PR is its number (pull_requests, or the number in a ciflow tag), or for a fork PR, whose run
-- carries no pull_requests, head repository and branch. A config is
-- 'workflow / job-name prefix before " / test (" / test config'. Files are compared by hash.
-- Rows: one per day of the later run's creation, one per week of it (bucket = its ISO Monday),
-- 'hist' rows, one per 0.1 point of change over the changed pairs (bucket_pct = the change
-- floored to 0.1, pairs = their count, bucket '' and the other columns 0), and a total row that is
-- always present. bucket_pct is 0 outside 'hist'. The window ends at most now and spans at most
-- 49 days. ClickHouse runs a CTE at every reference, so each CTE here is referenced once.
WITH
least({stopTime: DateTime64(3)}, now64(3)) AS window_end,
greatest(
    {startTime: DateTime64(3)}, window_end - INTERVAL 49 DAY
) AS window_start,
window_start - INTERVAL 14 DAY AS sets_start,

runs AS (
    SELECT
        id,
        created_at,
        event = 'push' AND head_branch = 'main' AS is_main,
        multiIf(
            is_main, '',
            head_branch LIKE 'ciflow/%', extract(head_branch, '/(\\d+)$'),
            length(pull_requests) > 0,
            toString(tupleElement(pull_requests[1], 'number')),
            concat(head_repository.full_name, ':', head_branch)
        ) AS pr
    FROM default.workflow_run
    WHERE
        id IN (
            SELECT id FROM materialized_views.workflow_run_by_created_at
            WHERE created_at >= sets_start AND created_at < window_end
        )
        AND startsWith(dynamoKey, 'pytorch/pytorch/')
        AND name = 'pull'
        AND (
            event = 'pull_request'
            OR head_branch LIKE 'ciflow/%'
            OR (
                event = 'push'
                AND head_branch = 'main'
                AND head_repository.full_name = 'pytorch/pytorch'
            )
        )
    LIMIT 1 BY id
),

-- Per (PR or main, config, head sha) whose latest attempt of every shard succeeded: those jobs.
green_jobs AS (
    SELECT
        is_main,
        pr,
        config,
        sha,
        min(created_at) AS created_at,
        groupArray(latest_id) AS job_ids
    FROM (
        SELECT
            r.is_main AS is_main,
            r.pr AS pr,
            j.config AS config,
            j.head_sha AS sha,
            j.shard AS shard,
            any(j.num_shards) AS num_shards,
            min(r.created_at) AS created_at,
            max(j.id) AS latest_id,
            argMax(j.conclusion, j.id) AS latest_conclusion
        FROM (
            SELECT
                id,
                run_id,
                head_sha,
                conclusion,
                created_at,
                splitByString(' / test (', name) AS name_parts,
                splitByString(', ', trimRight(name_parts[2], ')')) AS test_args,
                concat(workflow_name, ' / ', name_parts[1], ' / ', test_args[1])
                    AS config,
                test_args[2] AS shard,
                toUInt32OrZero(test_args[3]) AS num_shards
            FROM default.workflow_job
            WHERE
                created_at >= sets_start
                AND created_at < window_end + INTERVAL 1 DAY
                AND startsWith(dynamoKey, 'pytorch/pytorch/')
                AND status = 'completed'
                AND position(name, ' / test (') > 0
                AND workflow_name = 'pull'
                AND NOT arrayExists(
                    x -> position(name, x) > 0, ['macos', 'xpu', 'onnx']
                )
            LIMIT 1 BY id
        ) AS j
        INNER JOIN runs AS r ON j.run_id = r.id
        WHERE j.created_at < r.created_at + INTERVAL 1 DAY
        GROUP BY is_main, pr, config, sha, shard
    )
    WHERE num_shards > 0
    GROUP BY is_main, pr, config, sha
    HAVING
        count() = max(num_shards)
        AND countIf(latest_conclusion = 'success') = count()
),

-- File sets (hashes of invoking_file), kept when every job of the set reported files.
green_sets AS (
    SELECT
        g.is_main AS is_main,
        g.pr AS pr,
        g.config AS config,
        g.sha AS sha,
        any(g.created_at) AS created_at,
        arraySort(arrayDistinct(arrayFlatten(groupArray(f.files)))) AS files
    FROM (
        SELECT
            job_id,
            groupUniqArray(cityHash64(invoking_file)) AS files
        FROM default.test_run_summary
        WHERE
            workflow_id IN (
                SELECT id FROM default.workflow_run
                WHERE
                    id IN (
                        SELECT id
                        FROM materialized_views.workflow_run_by_created_at
                        WHERE
                            created_at >= sets_start
                            AND created_at < window_end
                    )
                    AND name = 'pull'
                    AND (
                        event = 'pull_request'
                        OR head_branch LIKE 'ciflow/%'
                        OR (event = 'push' AND head_branch = 'main')
                    )
            )
        GROUP BY job_id
    ) AS f
    INNER JOIN (
        SELECT
            is_main,
            pr,
            config,
            sha,
            created_at,
            length(job_ids) AS n_jobs,
            arrayJoin(job_ids) AS job_id
        FROM green_jobs
    ) AS g ON f.job_id = g.job_id
    GROUP BY g.is_main, g.pr, g.config, g.sha
    HAVING count() = any(g.n_jobs)
),

-- PR sets that are TD-on against the median of the config's main sets.
td_on_sets AS (
    SELECT
        pr,
        config,
        sha,
        created_at,
        files
    FROM (
        SELECT
            *,
            medianExactIf(length(files), is_main)
                OVER (PARTITION BY config) AS main_median,
            countIf(is_main) OVER (PARTITION BY config) AS main_sets
        FROM green_sets
    )
    WHERE NOT is_main AND main_sets > 0 AND length(files) <= main_median / 2
),

pairs AS (
    SELECT
        pr,
        tupleElement(seq[i], 1) AS earlier_created,
        tupleElement(seq[i + 1], 1) AS later_created,
        tupleElement(seq[i], 3) AS a,
        tupleElement(seq[i + 1], 3) AS b,
        a = b AS identical,
        length(arrayIntersect(a, b)) AS shared_files,
        length(arrayDistinct(arrayConcat(a, b))) AS all_files,
        100 * (1 - shared_files / all_files) AS change_pct,
        -- Not floor(change_pct * 10): float error puts exact tenths, such as 10%, a bucket low.
        floor(1000 * (all_files - shared_files) / all_files) / 10
            AS change_bucket
    FROM (
        SELECT
            pr,
            arraySort(groupArray((created_at, sha, files))) AS seq,
            arrayJoin(range(1, length(seq))) AS i
        FROM td_on_sets
        GROUP BY pr, config
    )
)

SELECT
    multiIf(
        grouping(day) = 0, 'day',
        grouping(week) = 0, 'week',
        grouping(change_bucket) = 0, 'hist',
        'total'
    ) AS grain,
    multiIf(grain = 'day', day, grain = 'week', week, '') AS bucket,
    count() AS pairs,
    countIf(identical) AS identical_pairs,
    if(
        grain = 'hist',
        0,
        ifNotFinite(
            quantileExactInclusiveIf(0.5) (change_pct, NOT identical), 0
        )
    ) AS changed_median_pct,
    if(grain = 'hist', 0, uniqExact(pr)) AS prs,
    if(grain = 'hist', change_bucket, 0) AS bucket_pct
FROM (
    SELECT
        pr,
        identical,
        change_pct,
        change_bucket,
        formatDateTime(later_created, '%F') AS day,
        formatDateTime(toMonday(later_created), '%F') AS week
    FROM pairs
    WHERE
        later_created >= window_start
        AND later_created < window_end
        AND earlier_created >= later_created - INTERVAL 14 DAY
)
GROUP BY GROUPING SETS ((day), (week), (identical, change_bucket), ())
HAVING grain != 'hist' OR NOT identical
ORDER BY grain, bucket, bucket_pct
SETTINGS max_execution_time = 60, max_threads = 8
