-- Trunk breakages that Target Determination (TD) may have let through: main landings reverted
-- within revertWindowDays, the test files that broke on trunk, and whether each broke test ran
-- on the reverted PR's head. One row per event plus one total row (always present).
--
-- ClickHouse inlines a CTE at every reference, so every stage that later stages read more than
-- once is collapsed into a one-row, one-column scalar: identical scalar subqueries are executed
-- once per query. Scalars are read through `(SELECT x FROM cte)` rather than `WITH (...) AS x`,
-- whose alias is copied into every subquery and overflows max_expanded_ast_elements.
WITH
-- Main pushes: (head, before, pushed_at, [(sha, landed PR, reverted sha, reverted PR,
-- trigger comment id, PR the comment is on)], landed in the window, revert window closed).
-- A stack lands and is reverted as one push. The window is clamped to now and to 90 days.
push_arr AS (
    WITH
        least({stopTime: DateTime64(3)}, now64(3)) AS window_end,
        greatest({startTime: DateTime64(3)}, window_end - toIntervalDay(90)) AS window_start
    SELECT groupArray(tuple(
        head, before_sha, pushed_at, members, pushed_at >= window_start AND pushed_at < window_end,
        pushed_at + toIntervalDay({revertWindowDays: UInt32}) <= now64(3)
    )) AS pushes
    FROM (
        SELECT
            head_commit.id AS head,
            before AS before_sha,
            toDateTime64(repository.pushed_at, 3) AS pushed_at,
            arrayMap(
                c -> tuple(
                    c.1,
                    if(
                        startsWith(c.2, 'Revert "'), 0,
                        toInt64OrZero(extract(splitByChar('\n', c.2)[1], '\\(#(\\d+)\\)\\s*$'))
                    ),
                    if(startsWith(c.2, 'Revert "'), extract(c.2, 'This reverts commit ([0-9a-f]+)\\.'), ''),
                    toInt64OrZero(extract(c.2, 'Reverted https://github\\.com/pytorch/pytorch/pull/(\\d+) on behalf of')),
                    toInt64OrZero(extract(c.2, '\\[comment\\]\\(https://github\\.com/pytorch/pytorch/pull/\\d+#issuecomment-(\\d+)\\)')),
                    toInt64OrZero(extract(c.2, '\\[comment\\]\\(https://github\\.com/pytorch/pytorch/pull/(\\d+)#issuecomment-'))
                ),
                arrayZip(commits.id, commits.message)
            ) AS members
        FROM default.push
        PREWHERE push.ref = 'refs/heads/main'
        WHERE
            push.repository.full_name = 'pytorch/pytorch'
            AND tupleElement(head_commit, 'timestamp') >= window_start - toIntervalHour(1)
            AND tupleElement(head_commit, 'timestamp') < window_end + toIntervalDay({revertWindowDays: UInt32})
        LIMIT 1 BY head
    )
),

revs AS (
    SELECT
        c.1 AS revert_sha,
        c.3 AS reverted_sha,
        c.4 AS reverted_pr,
        c.5 AS comment_id,
        c.6 AS comment_pr,
        p.1 AS revert_push,
        p.3 AS reverted_at
    FROM (SELECT p, arrayJoin(p.4) AS c FROM (SELECT arrayJoin((SELECT pushes FROM push_arr)) AS p))
    WHERE c.3 != '' AND c.4 > 0
),

-- The -c of the mergebot command the revert commit links to; '' when none is found.
classes AS (
    SELECT
        id AS comment_id,
        extract(
            replaceRegexpOne(
                argMax(body, updated_at),
                '(?s)(?:-m|--message)[\\s =]+(?:"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|“[^”]*”)',
                ' '
            ),
            '(?s)@pytorch(?:merge|)bot\\s+revert.*?(?:-c|--classification)[\\s =]+["\']?'
            || '(nosignal|ignoredsignal|landrace|weird|ghfirst|autorevert)'
        ) AS revert_class
    FROM default.issue_comment
    WHERE
        issue_url IN (
            SELECT concat('https://api.github.com/repos/pytorch/pytorch/issues/', toString(comment_pr))
            FROM revs
        )
        AND id IN (SELECT comment_id FROM revs)
    GROUP BY id
),

-- merges is keyed on PR and merge commit: a stack writes one merge_commit_sha for every member.
merge_heads AS (
    SELECT
        pr_num,
        merge_commit_sha,
        argMax(last_commit_sha, comment_id) AS head_sha
    FROM default.merges
    WHERE
        owner = 'pytorch' AND project = 'pytorch' AND pr_num IN (SELECT reverted_pr FROM revs)
        AND NOT is_failed AND NOT dry_run AND merge_commit_sha != ''
    GROUP BY pr_num, merge_commit_sha
),

run_heads AS (
    SELECT
        tupleElement(pull_requests[1], 'number') AS pr,
        head_sha,
        created_at
    FROM default.workflow_run
    WHERE
        id IN (
            SELECT id FROM materialized_views.workflow_run_by_pr_num
            WHERE pr_number IN (SELECT reverted_pr FROM revs)
        )
        AND startsWith(dynamoKey, 'pytorch/pytorch/') AND name = 'pull' AND status = 'completed'
),

-- One row per landing with its non-ghfirst reverts: (reverted_at, revert sha, PR, revert push,
-- reverted sha, class, PR head).
cand AS (
    SELECT
        landing_sha,
        landed_at,
        closed,
        any(before_sha) AS before_sha,
        any(stack_size) AS stack_size,
        arraySort(groupArrayIf(
            tuple(reverted_at, revert_sha, reverted_pr, revert_push, reverted_sha, revert_class, pr_head),
            revert_class != 'ghfirst'
        )) AS kept
    FROM (
        SELECT
            l.landing_sha AS landing_sha,
            l.landed_at AS landed_at,
            l.closed AS closed,
            any(l.before_sha) AS before_sha,
            any(l.stack_size) AS stack_size,
            r.reverted_at AS reverted_at,
            r.revert_sha AS revert_sha,
            r.reverted_pr AS reverted_pr,
            r.revert_push AS revert_push,
            r.reverted_sha AS reverted_sha,
            any(cl.revert_class) AS revert_class,
            anyIf(m.head_sha, m.merge_commit_sha = r.reverted_sha OR m.merge_commit_sha = l.landing_sha) AS merged_head,
            if(merged_head != '', merged_head, argMaxIf(w.head_sha, w.created_at, w.created_at < l.landed_at))
                AS pr_head
        FROM (
            SELECT
                p.1 AS landing_sha,
                p.2 AS before_sha,
                p.3 AS landed_at,
                p.6 AS closed,
                length(p.4) AS stack_size,
                arrayJoin(p.4).1 AS member_sha
            FROM (SELECT arrayJoin((SELECT pushes FROM push_arr)) AS p)
            WHERE p.5
        ) AS l
        INNER JOIN revs AS r ON r.reverted_sha = l.member_sha
        LEFT JOIN classes AS cl ON cl.comment_id = r.comment_id
        LEFT JOIN merge_heads AS m ON m.pr_num = r.reverted_pr
        LEFT JOIN run_heads AS w ON w.pr = r.reverted_pr
        WHERE r.reverted_at >= l.landed_at AND r.reverted_at < l.landed_at + toIntervalDay({revertWindowDays: UInt32})
        GROUP BY landing_sha, landed_at, closed, reverted_at, revert_sha, reverted_pr, revert_push, reverted_sha
    )
    GROUP BY landing_sha, landed_at, closed
),

-- (events, ghfirst-only landings with a closed window). An event also carries the first three
-- main pushes after the landing and before its first revert, for the confirmation check.
ev_arr AS (
    SELECT (
        groupArrayIf(
            tuple(
                landing_sha, landed_at, before_sha, stack_size, kept,
                arraySlice(arrayMap(p -> p.1, arraySort(p -> p.3, arrayFilter(
                    p -> p.3 > landed_at AND p.3 < kept[1].1, (SELECT pushes FROM push_arr)
                ))), 1, 3),
                closed
            ),
            notEmpty(kept)
        ),
        countIf(empty(kept) AND closed)
    ) AS ev
    FROM cand
),

-- Commits whose CI is read: L landing head, B main before it, R last revert push, N next
-- pushes, P reverted PR heads (ord carries the PR number).
roles AS (
    SELECT
        e.1 AS landing_sha,
        e.2 AS landed_at,
        arrayJoin(arrayConcat(
            [('L', toInt64(0), e.1), ('B', toInt64(0), e.3), ('R', toInt64(0), e.5[-1].4)],
            arrayMap((h, i) -> ('N', toInt64(i), h), e.6, arrayEnumerate(e.6)),
            arrayMap(k -> ('P', k.3, k.7), arrayFilter(k -> k.7 != '', e.5))
        )) AS r,
        r.1 AS role,
        r.2 AS ord,
        r.3 AS sha
    FROM (SELECT arrayJoin((SELECT ev FROM ev_arr).1) AS e)
),

ids_arr AS (
    SELECT groupArray(id) AS ids
    FROM materialized_views.workflow_job_by_head_sha
    WHERE head_sha IN (SELECT sha FROM roles)
),

-- Per (sha, shard-less config) of TD-workflow test jobs: every shard completed, failing
-- (file, run, attempt), failing cases, and the shards (id, name, success, day).
state_arr AS (
    SELECT groupArray(tuple(sha, config, completed, fails, cases, shards)) AS st
    FROM (
        SELECT
            j.head_sha AS sha,
            j.config AS config,
            uniqExactIf(j.name, j.status = 'completed' AND j.conclusion IN ('success', 'failure'))
            = uniqExact(j.name) AS completed,
            groupUniqArrayIf(tuple(f.test_file, j.run_id, j.run_attempt), f.test_file != '' AND j.conclusion = 'failure')
                AS fails,
            groupUniqArrayIf(tuple(f.test_file, f.file, f.classname, f.name), f.test_file != '' AND j.conclusion = 'failure')
                AS cases,
            groupUniqArray(tuple(j.id, j.name, j.status = 'completed' AND j.conclusion = 'success', toDate(j.created_at)))
                AS shards
        FROM (
            SELECT
                id,
                head_sha,
                run_id,
                run_attempt,
                name,
                status,
                conclusion,
                created_at,
                concat(
                    workflow_name, ' / ', splitByString(' / test (', name)[1], ' / ',
                    trimBoth(splitByChar(',', splitByString(' / test (', name)[2])[1])
                ) AS config
            FROM default.workflow_job
            WHERE
                id IN (SELECT arrayJoin((SELECT ids FROM ids_arr)))
                AND startsWith(dynamoKey, 'pytorch/pytorch/')
                AND (
                    workflow_name IN {tdWorkflows: Array(String)}
                    OR arrayExists(w -> startsWith(workflow_name, w), {tdWorkflowPrefixes: Array(String)})
                )
                AND position(name, ' / test (') > 0
        ) AS j
        LEFT JOIN (
            SELECT job_id, replaceAll(invoking_file, '.', '/') AS test_file, file, classname, name
            FROM default.failed_test_runs
            WHERE
                job_id IN (SELECT arrayJoin((SELECT ids FROM ids_arr)))
                AND (failure.size0 > 0 OR error.size0 > 0) AND invoking_file != 'expected'
        ) AS f ON f.job_id = j.id
        GROUP BY sha, config
    )
),

-- Breaking tests: (landing, config, file, failing cases, landed_at).
brk_arr AS (
    SELECT groupArray(t) AS brk
    FROM (
        SELECT arrayJoin(arrayMap(
            f -> tuple(
                landing_sha, config, f,
                arrayDistinct(arrayMap(x -> (x.2, x.3, x.4), arrayFilter(x -> x.1 = f, l.5))),
                landed_at
            ),
            arrayFilter(
                f -> b.3 AND NOT has(b.4.1, f) AND NOT (rv.3 AND has(rv.4.1, f))
                AND (length(arrayDistinct(arrayMap(x -> (x.2, x.3), arrayFilter(x -> x.1 = f, l.4)))) >= 2 OR has(n.4.1, f)),
                arrayDistinct(l.4.1)
            )
        )) AS t
        FROM (
            SELECT
                r.landing_sha AS landing_sha,
                r.landed_at AS landed_at,
                s.config AS config,
                groupArray(tuple(r.role, r.ord, s.completed, s.fails, s.cases)) AS sts,
                arrayFilter(x -> x.1 = 'L', sts)[1] AS l,
                arrayFilter(x -> x.1 = 'B', sts)[1] AS b,
                arrayFilter(x -> x.1 = 'R', sts)[1] AS rv,
                arraySort(x -> x.2, arrayFilter(x -> x.1 = 'N' AND x.3, sts))[1] AS n
            FROM roles AS r
            INNER JOIN (
                SELECT y.1 AS sha, y.2 AS config, y.3 AS completed, y.4 AS fails, y.5 AS cases
                FROM (SELECT arrayJoin((SELECT st FROM state_arr)) AS y)
            ) AS s ON s.sha = r.sha
            WHERE r.role != 'P'
            GROUP BY landing_sha, landed_at, config
        )
    )
),

-- Shards of every breaking config at each reverted PR's head.
pr_jobs AS (
    SELECT b.landing_sha AS landing_sha, p.ord AS pr, b.config AS config, arrayJoin(s.shards) AS j
    FROM (
        SELECT DISTINCT x.1 AS landing_sha, x.2 AS config
        FROM (SELECT arrayJoin((SELECT brk FROM brk_arr)) AS x)
    ) AS b
    INNER JOIN (SELECT landing_sha, ord, sha FROM roles WHERE role = 'P') AS p ON p.landing_sha = b.landing_sha
    INNER JOIN (
        SELECT y.1 AS sha, y.2 AS config, y.6 AS shards FROM (SELECT arrayJoin((SELECT st FROM state_arr)) AS y)
    ) AS s ON s.sha = p.sha AND s.config = b.config
),

-- Files each PR job ran. tests.all_test_runs is only read by (job_id, day): the partition and
-- the sort key both prune, where a time range over months costs a minute.
pr_files AS (
    SELECT job_id, groupUniqArray(replaceAll(invoking_file, '.', '/')) AS files
    FROM tests.all_test_runs
    WHERE (job_id, toDate(time_inserted)) IN (SELECT j.1, arrayJoin([j.4, j.4 + 1]) FROM pr_jobs)
    GROUP BY job_id
),

pr_cfg AS (
    SELECT landing_sha, pr, config, min(shard_ok) AS all_green, arrayDistinct(arrayFlatten(groupArray(shard_files))) AS files
    FROM (
        SELECT
            pj.landing_sha AS landing_sha,
            pj.pr AS pr,
            pj.config AS config,
            argMax(pj.j.3 AND notEmpty(pf.files), (pj.j.1, pj.j.3)) AS shard_ok,
            arrayDistinct(arrayFlatten(groupArray(pf.files))) AS shard_files
        FROM pr_jobs AS pj
        LEFT JOIN pr_files AS pf ON pf.job_id = pj.j.1
        GROUP BY landing_sha, pr, config, pj.j.2
    )
    GROUP BY landing_sha, pr, config
),

-- Test-case age: a case is old for an event when it ran in CI on or before landed_at -
-- newTestDays. min() over a case's whole history reads months of rows, so the day of and before
-- that cutoff are read first; only cases those days leave unproven have their full history read.
cases AS (
    SELECT x.1 AS landing_sha, x.2 AS config, x.3 AS test_file, c.1 AS c_file, c.2 AS c_class, c.3 AS c_name,
        x.5 - toIntervalDay({newTestDays: UInt32}) AS cutoff
    FROM (SELECT x, arrayJoin(x.4) AS c FROM (SELECT arrayJoin((SELECT brk FROM brk_arr)) AS x))
),

seen_near AS (
    SELECT file, classname, name, min(time_inserted) AS first_seen
    FROM tests.all_test_runs_by_name
    WHERE (file, classname, name, toDate(time_inserted)) IN (
        SELECT c_file, c_class, c_name, arrayJoin([toDate(cutoff) - 1, toDate(cutoff)]) FROM cases
    )
    GROUP BY file, classname, name
),

seen_far AS (
    SELECT file, classname, name, min(time_inserted) AS first_seen
    FROM tests.all_test_runs_by_name
    WHERE
        (file, classname, name) IN (
            SELECT c.c_file, c.c_class, c.c_name
            FROM cases AS c
            LEFT JOIN seen_near AS s ON s.file = c.c_file AND s.classname = c.c_class AND s.name = c.c_name
            WHERE s.name = '' OR s.first_seen > c.cutoff
        )
        AND time_inserted < least({stopTime: DateTime64(3)}, now64(3)) - toIntervalDay({newTestDays: UInt32})
    GROUP BY file, classname, name
),

tests AS (
    SELECT
        c.landing_sha AS landing_sha,
        c.config AS config,
        c.test_file AS test_file,
        max((sn.name != '' AND sn.first_seen <= c.cutoff) OR (sf.name != '' AND sf.first_seen <= c.cutoff)) AS old
    FROM cases AS c
    LEFT JOIN seen_near AS sn ON sn.file = c.c_file AND sn.classname = c.c_class AND sn.name = c.c_name
    LEFT JOIN seen_far AS sf ON sf.file = c.c_file AND sf.classname = c.c_class AND sf.name = c.c_name
    GROUP BY landing_sha, config, test_file
),

outcomes AS (
    SELECT
        t.landing_sha AS landing_sha,
        t.config AS config,
        t.test_file AS test_file,
        h.pr AS pr,
        multiIf(
            h.pr_head = '', 'unknown',
            pc.landing_sha = '', 'config_not_on_pr',
            has(pc.files, t.test_file), 'ran_on_pr',
            NOT pc.all_green OR arrayExists(m -> position(t.config, m) > 0, {noTdBuildMarkers: Array(String)}), 'unknown',
            t.old, 'td_skipped',
            'new_test'
        ) AS outcome
    FROM tests AS t
    INNER JOIN (
        SELECT DISTINCT e.1 AS landing_sha, k.3 AS pr, k.7 AS pr_head
        FROM (SELECT e, arrayJoin(e.5) AS k FROM (SELECT arrayJoin((SELECT ev FROM ev_arr).1) AS e))
    ) AS h ON h.landing_sha = t.landing_sha
    LEFT JOIN pr_cfg AS pc ON pc.landing_sha = t.landing_sha AND pc.pr = h.pr AND pc.config = t.config
),

-- One row per event: (event, [(config, file, PR, outcome)], outcome, window closed).
out_arr AS (
    SELECT groupArray(tuple(
        ev_row, o.tl,
        multiIf(
            ev_row.5[1].6 = 'landrace', 'landrace',
            has(o.tl.4, 'ran_on_pr'), 'caught_on_pr',
            has(o.tl.4, 'td_skipped'), 'false_green',
            has(o.tl.4, 'new_test'), 'new_test',
            arrayAll(x -> x = 'config_not_on_pr', o.tl.4), 'not_in_pr_matrix',
            'unknown'
        ),
        ev_row.7
    )) AS outs
    FROM (SELECT arrayJoin((SELECT ev FROM ev_arr).1) AS ev_row, ev_row.1 AS landing_sha) AS er
    LEFT JOIN (
        SELECT landing_sha, arraySort(groupArray(tuple(config, test_file, pr, outcome))) AS tl
        FROM outcomes
        GROUP BY landing_sha
    ) AS o ON o.landing_sha = er.landing_sha
)

SELECT
    x.1 AS grain,
    x.2 AS landed_at,
    x.3 AS landing_sha,
    x.4 AS reverted_prs,
    x.5 AS revert_shas,
    x.6 AS reverted_at,
    x.7 AS revert_class,
    x.8 AS stack_size,
    x.9 AS outcome,
    x.10 AS window_closed,
    x.11 AS test_configs,
    x.12 AS test_files,
    x.13 AS test_prs,
    x.14 AS test_outcomes,
    x.15 AS landed_prs,
    x.16 AS events,
    x.17 AS false_green,
    x.18 AS caught_on_pr,
    x.19 AS new_test,
    x.20 AS not_in_pr_matrix,
    x.21 AS landrace,
    x.22 AS unknown,
    x.23 AS other_reverts,
    x.24 AS ghfirst_reverts
FROM (
    SELECT arrayJoin(arrayConcat(
        [tuple(
            'total', toDateTime64(0, 3), '', CAST([], 'Array(Int64)'), CAST([], 'Array(String)'),
            toDateTime64(0, 3), '', toUInt32(0), '', toUInt8(0), CAST([], 'Array(String)'),
            CAST([], 'Array(String)'), CAST([], 'Array(Int64)'), CAST([], 'Array(String)'),
            arraySum(p -> if(p.5 AND p.6, arrayCount(c -> c.2 > 0, p.4), 0), (SELECT pushes FROM push_arr)),
            arrayCount(o -> o.4 AND notEmpty(o.2), outs),
            arrayCount(o -> o.4 AND notEmpty(o.2) AND o.3 = 'false_green', outs),
            arrayCount(o -> o.4 AND notEmpty(o.2) AND o.3 = 'caught_on_pr', outs),
            arrayCount(o -> o.4 AND notEmpty(o.2) AND o.3 = 'new_test', outs),
            arrayCount(o -> o.4 AND notEmpty(o.2) AND o.3 = 'not_in_pr_matrix', outs),
            arrayCount(o -> o.4 AND notEmpty(o.2) AND o.3 = 'landrace', outs),
            arrayCount(o -> o.4 AND notEmpty(o.2) AND o.3 = 'unknown', outs),
            arrayCount(o -> o.4 AND empty(o.2), outs),
            toUInt64((SELECT ev FROM ev_arr).2)
        )],
        arrayMap(o -> tuple(
            'event', o.1.2, o.1.1, arraySort(arrayDistinct(o.1.5.3)), o.1.5.2, o.1.5[1].1, o.1.5[1].6,
            toUInt32(o.1.4), o.3, toUInt8(o.4), o.2.1, o.2.2, o.2.3, o.2.4,
            toUInt64(0), toUInt64(0), toUInt64(0), toUInt64(0), toUInt64(0), toUInt64(0), toUInt64(0),
            toUInt64(0), toUInt64(0), toUInt64(0)
        ), arraySlice(arrayReverseSort(o -> o.1.2, arrayFilter(o -> notEmpty(o.2), outs)), 1, 1000))
    )) AS x
    FROM (SELECT (SELECT outs FROM out_arr) AS outs)
)
SETTINGS max_execution_time = 60
