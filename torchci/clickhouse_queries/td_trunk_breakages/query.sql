-- Trunk breakages TD may have let through: main landings with a bot revert within
-- revertWindowDays, the (config, test file) pairs they broke on trunk, and what each broken
-- file did on the reverted PR's head. One row per event plus one total row (always present).
--
-- A breaking test fails (failure or error, not rerun-only) in a failed job of the config at the
-- landing head; fails again in a second attempt there or at the next main push where the config
-- completed (only the immediate next push is read); completed without failing it at the push's
-- `before`; and does not fail at the last revert push when the config completed there.
--
-- PR side: only PR-head jobs created before the landing count (a revert reopens the PR and
-- re-runs CI at the same head sha). A file that ran there and passed did not catch the break,
-- so a td_skipped pair still makes its event a false green. tests.all_test_runs costs ~140 ms
-- per job single-threaded (cold S3 granules), so it is read only for configs green in every
-- shard at the PR head (else the pair is 'unknown') and for each event's first 100 (config,
-- file) pairs (a landing can break over 1,500); later pairs are 'not_checked'. A td_skipped
-- candidate is 'new_test' when no failing case ran in CI in the 3 days ending newTestDays
-- before the landing although all_test_runs_by_name already had rows by then.
--
-- ClickHouse re-runs a CTE at every reference but runs identical scalar subqueries once per
-- query, so each stage read more than once is a one-row scalar read as `(SELECT x FROM cte)`.
-- A scalar whose query holds `IN (SELECT arrayJoin((SELECT ...)))` is not cached, nor is any
-- scalar built on it, hence the extra SELECT level in state_arr's IN lists (3x fewer rows read).
-- The old analyzer runs this query about 8x slower, hence allow_experimental_analyzer.
WITH
-- (head, before, pushed_at, [(sha, landed PR, reverted sha, reverted PR, trigger comment, its PR)],
-- landed in the window, revert window closed). Window clamped to now and to 90 days.
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
            arrayMap(c -> tuple(
                c.1,
                if(startsWith(c.2, 'Revert "'), 0, toInt64OrZero(extract(splitByChar('\n', c.2)[1], '\\(#(\\d+)\\)\\s*$'))),
                if(startsWith(c.2, 'Revert "'), extract(c.2, 'This reverts commit ([0-9a-f]+)\\.'), ''),
                toInt64OrZero(extract(c.2, 'Reverted https://github\\.com/pytorch/pytorch/pull/(\\d+) on behalf of')),
                toInt64OrZero(extract(c.2, '\\[comment\\]\\(https://github\\.com/pytorch/pytorch/pull/\\d+#issuecomment-(\\d+)\\)')),
                toInt64OrZero(extract(c.2, '\\[comment\\]\\(https://github\\.com/pytorch/pytorch/pull/(\\d+)#issuecomment-'))
            ), arrayZip(commits.id, commits.message)) AS members
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
        c.1 AS revert_sha, c.3 AS reverted_sha, c.4 AS reverted_pr, c.5 AS comment_id, c.6 AS comment_pr,
        p.1 AS revert_push, p.3 AS reverted_at
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
    WHERE (issue_url, id) IN (
        SELECT concat('https://api.github.com/repos/pytorch/pytorch/issues/', toString(comment_pr)), comment_id
        FROM revs
    )
    GROUP BY id
),

-- merges is keyed on PR and merge commit: a stack writes one merge_commit_sha for every member.
merge_heads AS (
    SELECT pr_num, merge_commit_sha, argMax(last_commit_sha, comment_id) AS head_sha
    FROM default.merges
    WHERE
        owner = 'pytorch' AND project = 'pytorch' AND pr_num IN (SELECT reverted_pr FROM revs)
        AND NOT is_failed AND NOT dry_run AND merge_commit_sha != ''
    GROUP BY pr_num, merge_commit_sha
),
run_heads AS (
    SELECT tupleElement(pull_requests[1], 'number') AS pr, head_sha, created_at
    FROM default.workflow_run
    WHERE
        id IN (SELECT id FROM materialized_views.workflow_run_by_pr_num WHERE pr_number IN (SELECT reverted_pr FROM revs))
        AND startsWith(dynamoKey, 'pytorch/pytorch/') AND name = 'pull' AND status = 'completed'
),

-- Per landing, its non-ghfirst reverts: (reverted_at, sha, PR, revert push, reverted sha, class, PR head).
cand AS (
    SELECT
        landing_sha, landed_at, closed, any(before_sha) AS before_sha, any(stack_size) AS stack_size,
        arraySort(groupArrayIf(
            tuple(reverted_at, revert_sha, reverted_pr, revert_push, reverted_sha, revert_class, pr_head),
            revert_class != 'ghfirst'
        )) AS kept
    FROM (
        SELECT
            l.landing_sha AS landing_sha, l.landed_at AS landed_at, l.closed AS closed,
            any(l.before_sha) AS before_sha, any(l.stack_size) AS stack_size,
            r.reverted_at AS reverted_at, r.revert_sha AS revert_sha, r.reverted_pr AS reverted_pr,
            r.revert_push AS revert_push, r.reverted_sha AS reverted_sha, any(cl.revert_class) AS revert_class,
            anyIf(m.head_sha, m.merge_commit_sha = r.reverted_sha OR m.merge_commit_sha = l.landing_sha) AS merged_head,
            if(merged_head != '', merged_head, argMaxIf(w.head_sha, w.created_at, w.created_at < l.landed_at))
                AS pr_head
        FROM (
            SELECT
                p.1 AS landing_sha, p.2 AS before_sha, p.3 AS landed_at, p.6 AS closed,
                length(p.4) AS stack_size, tupleElement(arrayJoin(p.4), 1) AS member_sha
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

-- ([(landing, landed_at, before, stack size, reverts, [next push before the first revert],
-- window closed)], ghfirst-only landings with a closed window).
ev_arr AS (
    SELECT (
        groupArrayIf(
            tuple(
                landing_sha, landed_at, before_sha, stack_size, kept,
                arraySlice(arrayMap(p -> p.1, arraySort(p -> p.3, arrayFilter(
                    p -> p.3 > landed_at AND p.3 < kept[1].1, (SELECT pushes FROM push_arr)
                ))), 1, 1),
                closed
            ),
            notEmpty(kept)
        ),
        countIf(empty(kept) AND closed)
    ) AS ev
    FROM cand
),

-- Commits whose CI is read: L landing head, B its `before`, R last revert push, N next push,
-- P reverted PR heads (ord carries the PR number).
roles AS (
    SELECT
        e.1 AS landing_sha, e.2 AS landed_at,
        arrayJoin(arrayConcat(
            [('L', toInt64(0), e.1), ('B', toInt64(0), e.3), ('R', toInt64(0), tupleElement(e.5[-1], 4))],
            arrayMap((h, i) -> ('N', toInt64(i), h), e.6, arrayEnumerate(e.6)),
            arrayMap(k -> ('P', k.3, k.7), arrayFilter(k -> k.7 != '', e.5))
        )) AS r,
        r.1 AS role, r.2 AS ord, r.3 AS sha
    FROM (SELECT arrayJoin((SELECT ev FROM ev_arr).1) AS e)
),
ids_arr AS (
    SELECT groupArray(id) AS ids FROM materialized_views.workflow_job_by_head_sha WHERE head_sha IN (SELECT sha FROM roles)
),
-- Per (sha, shard-less config) of TD-workflow test jobs: every shard completed, failing
-- (file, run, attempt, created), failing cases, shards (id, name, success, created).
state_arr AS (
    SELECT groupArray(tuple(sha, config, completed, fails, cases, shards)) AS st
    FROM (
        SELECT
            j.head_sha AS sha, j.config AS config,
            uniqExactIf(j.name, j.status = 'completed' AND j.conclusion IN ('success', 'failure'))
            = uniqExact(j.name) AS completed,
            groupUniqArrayIf(
                (f.test_file, j.run_id, j.run_attempt, j.created_at), f.test_file != '' AND j.conclusion = 'failure'
            ) AS fails,
            groupUniqArrayIf(
                (f.test_file, f.file, f.classname, f.name), f.test_file != '' AND j.conclusion = 'failure'
            ) AS cases,
            groupUniqArray((j.id, j.name, j.status = 'completed' AND j.conclusion = 'success', j.created_at)) AS shards
        FROM (
            SELECT
                id, head_sha, run_id, run_attempt, name, status, conclusion, created_at,
                concat(
                    workflow_name, ' / ', splitByString(' / test (', name)[1], ' / ',
                    trimBoth(splitByChar(',', splitByString(' / test (', name)[2])[1])
                ) AS config
            FROM default.workflow_job
            PREWHERE id IN (SELECT i FROM (SELECT arrayJoin((SELECT ids FROM ids_arr)) AS i))
            WHERE
                startsWith(dynamoKey, 'pytorch/pytorch/')
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
                job_id IN (SELECT i FROM (SELECT arrayJoin((SELECT ids FROM ids_arr)) AS i))
                AND (failure.size0 > 0 OR error.size0 > 0) AND invoking_file != 'expected'
        ) AS f ON f.job_id = j.id
        GROUP BY sha, config
    )
),

-- Breaking tests by (landing, config, file): (landing, config, file, failing cases, landed_at,
-- [(PR, shards, failing files)], among the event's first 100 pairs).
brk_arr AS (
    SELECT
        arraySort(t -> (t.1, t.2, t.3), groupArray(t)) AS s,
        arrayMap((t, k) -> tuple(t.1, t.2, t.3, t.4, t.5, t.6, k <= 100), s, arrayEnumerateUniq(s.1)) AS brk
    FROM (
        SELECT arrayJoin(arrayMap(
            f -> tuple(
                landing_sha, config, f, arrayDistinct(arrayMap(x -> (x.2, x.3, x.4), arrayFilter(x -> x.1 = f, l.5))),
                landed_at, prs
            ),
            arrayFilter(
                f -> b.3 AND NOT has(b.4.1, f) AND NOT (rv.3 AND has(rv.4.1, f))
                AND (length(arrayDistinct(arrayMap(x -> (x.2, x.3), arrayFilter(x -> x.1 = f, l.4)))) >= 2 OR has(n.4.1, f)),
                arrayDistinct(l.4.1)
            )
        )) AS t
        FROM (
            SELECT
                r.landing_sha AS landing_sha, r.landed_at AS landed_at, s.config AS config,
                groupArray(tuple(r.role, r.ord, s.completed, s.fails, s.cases, s.shards)) AS sts,
                arrayFilter(x -> x.1 = 'L', sts)[1] AS l,
                arrayFilter(x -> x.1 = 'B', sts)[1] AS b,
                arrayFilter(x -> x.1 = 'R', sts)[1] AS rv,
                arraySort(x -> x.2, arrayFilter(x -> x.1 = 'N' AND x.3, sts))[1] AS n,
                arrayFilter(p -> notEmpty(p.2), arrayMap(
                    x -> (x.2, arrayFilter(s -> s.4 < landed_at, x.6), tupleElement(arrayFilter(v -> v.4 < landed_at, x.4), 1)),
                    arrayFilter(x -> x.1 = 'P', sts)
                )) AS prs
            FROM roles AS r
            INNER JOIN (
                SELECT y.1 AS sha, y.2 AS config, y.3 AS completed, y.4 AS fails, y.5 AS cases, y.6 AS shards
                FROM (SELECT arrayJoin((SELECT st FROM state_arr)) AS y)
            ) AS s ON s.sha = r.sha
            GROUP BY landing_sha, landed_at, config
        )
    )
),

-- Shards whose files can change a checked pair's outcome: config all green at the PR head (each
-- shard's latest attempt succeeded), file not failing there. (landing, config, file, PR, job, latest, created).
green_shards AS (
    SELECT arrayJoin(arrayFlatten(arrayMap(b -> arrayFlatten(arrayMap(
        pe -> if(
            b.7 AND NOT has(pe.3, b.3) AND arrayAll(s -> s.3 OR s.1 != arrayMax(arrayFilter(u -> u.2 = s.2, pe.2).1), pe.2),
            arrayMap(s -> (b.1, b.2, b.3, pe.1, s.1, s.1 = arrayMax(arrayFilter(u -> u.2 = s.2, pe.2).1), s.4), pe.2),
            []
        ), b.6
    )), brk))) AS g
    FROM (SELECT (SELECT brk FROM brk_arr) AS brk)
),

-- (landing, config, file, PR, file ran in any shard, every shard's latest attempt has test rows).
pres_arr AS (
    SELECT groupArray(tuple(landing_sha, config, test_file, pr, ran, rows_ok)) AS pres
    FROM (
        SELECT
            g.1 AS landing_sha, g.2 AS config, g.3 AS test_file, g.4 AS pr,
            max(has(f.files, g.3)) AS ran, min(NOT g.6 OR f.job_id != 0) AS rows_ok
        FROM green_shards AS gs
        LEFT JOIN (
            SELECT job_id, groupUniqArray(replaceAll(invoking_file, '.', '/')) AS files
            FROM tests.all_test_runs
            WHERE (job_id, toDate(time_inserted)) IN (SELECT g.5, arrayJoin([toDate(g.7), toDate(g.7) + 1]) FROM green_shards)
            GROUP BY job_id
        ) AS f ON f.job_id = g.5
        GROUP BY landing_sha, config, test_file, pr
    )
),

-- Per breaking test: (landing, config, file, probe case, landed_at, [(PR, failed, green, ran, rows ok)],
-- checked). The probe case skips ('', 'pytest', 'internal'), which failed_test_runs files under any file.
tp_arr AS (
    SELECT arrayMap(b -> (
        b.1, b.2, b.3, arraySort(c -> (c.1 = '', c), b.4)[1], b.5,
        arrayMap(pe -> (
            pe.1, has(pe.3, b.3),
            arrayAll(s -> s.3 OR s.1 != arrayMax(arrayFilter(u -> u.2 = s.2, pe.2).1), pe.2),
            tupleElement(arrayFirst(x -> x.1 = b.1 AND x.2 = b.2 AND x.3 = b.3 AND x.4 = pe.1, pres), 5),
            tupleElement(arrayFirst(x -> x.1 = b.1 AND x.2 = b.2 AND x.3 = b.3 AND x.4 = pe.1, pres), 6)
        ), b.6), b.7
    ), brk) AS tp
    FROM (SELECT (SELECT brk FROM brk_arr) AS brk, (SELECT pres FROM pres_arr) AS pres)
),

-- (probe case, day) over each td_skipped candidate's 3-day window. age_arr filters case and day
-- apart: a 4-tuple IN over all_test_runs_by_name's sort key reads ~7x slower.
probes AS (
    SELECT arrayJoin(arrayMap(i -> (c.4, toDate(c.5 - toIntervalDay({newTestDays: UInt32})) - i), [0, 1, 2])) AS p
    FROM (
        SELECT arrayJoin(arrayFilter(
            t -> t.7 AND arrayExists(x -> x.3 AND NOT x.2 AND NOT x.4 AND x.5, t.6)
            AND NOT arrayExists(m -> position(t.2, m) > 0, {noTdBuildMarkers: Array(String)}),
            (SELECT tp FROM tp_arr)
        )) AS c
    )
),
age_arr AS (
    SELECT groupArray((file, classname, name, d, t)) AS ages
    FROM (
        SELECT file, classname, name, toDate(time_inserted) AS d, min(time_inserted) AS t
        FROM tests.all_test_runs_by_name
        WHERE (file, classname, name) IN (SELECT p.1 FROM probes) AND toDate(time_inserted) IN (SELECT p.2 FROM probes)
        GROUP BY file, classname, name, d
    )
),

-- One row per event: (event, first 50 [(config, file, PR, outcome)], outcome, window closed,
-- breaking tests, any td_skipped).
out_arr AS (
    SELECT groupArray(tuple(
        e, arraySlice(tl, 1, 50),
        multiIf(
            e.5[1].6 = 'landrace', 'landrace',
            has(tl.4, 'failed_on_pr'), 'signal_on_pr',
            has(tl.4, 'td_skipped'), 'false_green',
            has(tl.4, 'new_test'), 'new_test',
            has(tl.4, 'passed_on_pr'), 'passed_on_pr',
            arrayAll(x -> x = 'config_not_on_pr', tl.4), 'not_in_pr_matrix',
            'unknown'
        ),
        e.7, length(et), has(tl.4, 'td_skipped')
    )) AS outs
    FROM (
        SELECT
            e, arrayFilter(t -> t.1 = e.1, tp) AS et,
            arraySort(arrayFlatten(arrayMap(
                t -> arrayMap(
                    q -> (t.2, t.3, q.1, multiIf(
                        q.2 = '', 'unknown',
                        q.3.1 != q.1, 'config_not_on_pr',
                        q.3.2, 'failed_on_pr',
                        NOT q.3.3, 'unknown',
                        NOT t.7, 'not_checked',
                        q.3.4, 'passed_on_pr',
                        NOT q.3.5 OR arrayExists(m -> position(t.2, m) > 0, {noTdBuildMarkers: Array(String)}), 'unknown',
                        t.8, 'td_skipped',
                        'new_test'
                    )),
                    arrayMap(k -> (k.1, k.2, arrayFirst(x -> x.1 = k.1, t.6)), arrayDistinct(arrayMap(k -> (k.3, k.7), e.5)))
                ),
                et
            ))) AS tl
        FROM (
            SELECT
                arrayJoin((SELECT ev FROM ev_arr).1) AS e,
                arrayMap(t -> (
                    t.1, t.2, t.3, t.4, t.5, t.6, t.7,
                    (SELECT min(time_inserted) FROM tests.all_test_runs_by_name) > t.5 - toIntervalDay({newTestDays: UInt32})
                    OR arrayExists(
                        a -> (a.1, a.2, a.3) = t.4
                        AND a.4 >= toDate(t.5 - toIntervalDay({newTestDays: UInt32})) - 2
                        AND a.5 <= t.5 - toIntervalDay({newTestDays: UInt32}),
                        ages
                    )
                ), tp_raw) AS tp
            FROM (SELECT (SELECT tp FROM tp_arr) AS tp_raw, (SELECT ages FROM age_arr) AS ages)
        )
    )
)

SELECT
    x.1 AS grain, x.2 AS landed_at, x.3 AS landing_sha, x.4 AS reverted_prs, x.5 AS revert_shas, x.6 AS reverted_at,
    x.7 AS revert_class, x.8 AS stack_size, x.9 AS outcome, x.10 AS window_closed, x.11 AS breaking_tests,
    x.12 AS test_configs, x.13 AS test_files, x.14 AS test_prs, x.15 AS test_outcomes, x.16 AS landed_prs, x.17 AS events,
    x.18 AS false_green, x.19 AS signal_on_pr, x.20 AS passed_on_pr, x.21 AS new_test, x.22 AS not_in_pr_matrix,
    x.23 AS landrace, x.24 AS unknown, x.25 AS td_skipped_any, x.26 AS other_reverts, x.27 AS ghfirst_reverts
FROM (
    SELECT arrayJoin(arrayConcat(
        [tuple(
            'total', toDateTime64(0, 3), '', [], [], toDateTime64(0, 3), '', 0, '', 0, 0, [], [], [], [],
            arraySum(p -> if(p.5 AND p.6, arrayCount(c -> c.2 > 0, p.4), 0), (SELECT pushes FROM push_arr)),
            toUInt64(length(ce)), countEqual(ce.3, 'false_green'), countEqual(ce.3, 'signal_on_pr'),
            countEqual(ce.3, 'passed_on_pr'), countEqual(ce.3, 'new_test'), countEqual(ce.3, 'not_in_pr_matrix'),
            countEqual(ce.3, 'landrace'), countEqual(ce.3, 'unknown'), toUInt64(arrayCount(ce.6)),
            toUInt64(arrayCount(o -> o.4 AND empty(o.2), outs)), toUInt64((SELECT ev FROM ev_arr).2)
        )],
        arrayMap(o -> tuple(
            'event', o.1.2, o.1.1, arraySort(arrayDistinct(o.1.5.3)), o.1.5.2, o.1.5[1].1, o.1.5[1].6, toUInt32(o.1.4),
            o.3, toUInt8(o.4), toUInt64(o.5), o.2.1, o.2.2, o.2.3, o.2.4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
        ), arraySlice(arrayReverseSort(o -> o.1.2, arrayFilter(o -> notEmpty(o.2), outs)), 1, 1000))
    )) AS x
    FROM (SELECT outs, arrayFilter(o -> o.4 AND notEmpty(o.2), outs) AS ce FROM (SELECT (SELECT outs FROM out_arr) AS outs))
)
SETTINGS max_execution_time = 60, allow_experimental_analyzer = 1
