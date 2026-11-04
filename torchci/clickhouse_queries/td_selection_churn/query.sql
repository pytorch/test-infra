-- How much TD's picks change between consecutive pushes of the same pytorch/pytorch PR. For each
-- (PR, config, head sha) of a `pull` run (pull_request event or ciflow tag push):
-- the set of test files that ran across all shards (test_run_summary), only when the latest
-- attempt of every shard concluded success and reported test files. A set counts as TD-on when it
-- holds at most half the median file count of that config's green sets on main pushes in the
-- window; TD-off sets and configs without a main baseline are dropped. Pairs are consecutive
-- remaining head shas of a PR and config, ordered by run creation; identical when the sets are
-- equal, change = 100 * (1 - |A and B| / |A or B|) otherwise.
--
-- A PR is its number (pull_requests, or the number in a ciflow tag), or for a fork PR, whose run
-- carries no pull_requests, head repository and branch. A config is
-- 'workflow / job-name prefix before " / test (" / test config'. Files are compared by hash.
-- Jobs are read up to a day after the window, so a re-run started later is not seen. Rows: one
-- per day of the later run's creation, and a total row that is always present. The window ends
-- at most now and spans at most 14 days (test_run_summary's TTL is 30). Every CTE is read once.
WITH
least({stopTime: DateTime64(3)}, now64(3)) AS window_end,
greatest(
    {startTime: DateTime64(3)}, window_end - INTERVAL 14 DAY
) AS window_start,

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
            WHERE created_at >= window_start AND created_at < window_end
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
                splitByString(' / test (', name) AS name_parts,
                splitByString(', ', trimRight(name_parts[2], ')')) AS test_args,
                concat(workflow_name, ' / ', name_parts[1], ' / ', test_args[1])
                    AS config,
                test_args[2] AS shard,
                toUInt32OrZero(test_args[3]) AS num_shards
            FROM default.workflow_job
            WHERE
                created_at >= window_start
                AND created_at < least(window_end + INTERVAL 1 DAY, now64(3))
                AND startsWith(dynamoKey, 'pytorch/pytorch/')
                AND status = 'completed'
                AND position(name, ' / test (') > 0
                AND workflow_name = 'pull'
                AND NOT arrayExists(
                    x -> position(name, x) > 0,
                    {noTdBuildMarkers: Array(String)}
                )
            LIMIT 1 BY id
        ) AS j
        INNER JOIN runs AS r ON j.run_id = r.id
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
                            created_at >= window_start
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
        tupleElement(seq[i + 1], 1) AS later_created,
        tupleElement(seq[i], 3) AS a,
        tupleElement(seq[i + 1], 3) AS b,
        a = b AS identical,
        100 * (
            1
            - length(arrayIntersect(a, b))
            / length(arrayDistinct(arrayConcat(a, b)))
        ) AS change_pct
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
    if(grouping(day) = 1, 'total', 'day') AS grain,
    if(grain = 'day', day, '') AS bucket,
    count() AS pairs,
    countIf(identical) AS identical_pairs,
    ifNotFinite(quantileExactInclusiveIf(0.5) (change_pct, NOT identical), 0)
        AS changed_median_pct,
    uniqExact(pr) AS prs
FROM (
    SELECT
        pr,
        identical,
        change_pct,
        formatDateTime(later_created, '%F') AS day
    FROM pairs
)
GROUP BY GROUPING SETS ((day), ())
ORDER BY grain, bucket
SETTINGS max_execution_time = 60
