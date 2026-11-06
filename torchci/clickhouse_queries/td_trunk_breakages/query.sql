-- Trunk breakages TD may have let through: main landings with a bot revert within 7 days, the
-- (config, test file) pairs they broke on trunk, and what each broken file did on the reverted
-- PR's head. One row per event plus one total row (always present).
--
-- A breaking test fails (failure or error, not rerun-only) in a failed job of the config at the
-- landing head; fails again in a second attempt there or at the next main push where the config
-- completed (only the immediate next push is read); does not fail at the last revert push when
-- the config completed there; and the config completed at the push's `before`, where the file
-- failed in no TD-scope job of any config, not even one a rerun turned green (a culprit's failure
-- can show in one config only a push after another).
--
-- PR side: only PR-head jobs created before the landing count (a revert reopens the PR and
-- re-runs CI at the same head sha). tests.all_test_runs costs ~140 ms per job single-threaded
-- (cold S3 granules), so it is read only for configs green in every shard at the PR head (else
-- the pair is 'unknown') and for each event's first 100 (config, file) pairs (a landing can break
-- over 1,500); later pairs are 'not_checked'. A td_skipped candidate is 'new_test' when none of
-- its first 5 failing cases ran in CI in the 3 days ending 14 days before the landing although
-- all_test_runs_by_name already had rows by then. A td_skipped pair makes its event a false green
-- only when its file passed on none of the event's PR heads: a file that ran there and passed was
-- not broken in the PR's tree.
--
-- ClickHouse re-runs a CTE at every reference but runs identical scalar subqueries once per
-- query, so each stage read more than once is a one-row scalar read as `(SELECT x FROM cte)`.
-- A scalar whose query holds `IN (SELECT arrayJoin((SELECT ...)))` is not cached, nor is any
-- scalar built on it, hence the extra SELECT level in the IN lists over ids_arr (3x fewer rows
-- read). Each further reference to a late scalar still costs ~1 s, so out_arr is read once. The
-- old analyzer runs this query about 8x slower. Tuples are built from bare names only, which
-- enable_named_columns_in_function_tuple turns into field names. TD's scope is fixed in SQL: a
-- caller-sized array in a per-row lambda would scale a request's cost (tdWorkflows feeds IN only).
WITH
toIntervalDay(7) AS revert_window,
toIntervalDay(14) AS new_test_age,
['rocm-', 'periodic-rocm-'] AS td_workflow_prefixes,
['macos', 'xpu', 'onnx'] AS no_td_build_markers,
-- Main pushes; members are their commits. Window clamped to now, to 90 days and to 2026-07-13:
-- test jobs were named '<build> / test-osdc (...)' from March to early July 2026.
push_arr AS (
    WITH
        least({stopTime: DateTime64(3)}, now64(3)) AS window_end,
        greatest({startTime: DateTime64(3)}, window_end - toIntervalDay(90), toDateTime64('2026-07-13 00:00:00', 3)) AS window_start
    SELECT groupArray(tuple(head, before_sha, pushed_at, members, in_window, closed)) AS pushes
    FROM (
        SELECT
            head_commit.id AS head, before AS before_sha, toDateTime64(repository.pushed_at, 3) AS pushed_at,
            pushed_at >= window_start AND pushed_at < window_end AS in_window, pushed_at + revert_window <= now64(3) AS closed,
            arrayMap(
                (sha, landed_pr, reverted_sha, reverted_pr, comment_id, comment_pr)
                -> (sha, landed_pr, reverted_sha, reverted_pr, comment_id, comment_pr),
                commits.id,
                arrayMap(m -> if(startsWith(m, 'Revert "'), 0,
                    toInt64OrZero(extract(splitByChar('\n', m)[1], '\\(#(\\d+)\\)\\s*$'))), commits.message),
                arrayMap(m -> if(startsWith(m, 'Revert "'), extract(m, 'This reverts commit ([0-9a-f]+)\\.'), ''),
                    commits.message),
                arrayMap(m -> toInt64OrZero(extract(m,
                    'Reverted https://github\\.com/pytorch/pytorch/pull/(\\d+) on behalf of')), commits.message),
                arrayMap(m -> toInt64OrZero(extract(m,
                    '\\[comment\\]\\(https://github\\.com/pytorch/pytorch/pull/\\d+#issuecomment-(\\d+)\\)')), commits.message),
                arrayMap(m -> toInt64OrZero(extract(m,
                    '\\[comment\\]\\(https://github\\.com/pytorch/pytorch/pull/(\\d+)#issuecomment-')), commits.message)
            ) AS members
        FROM default.push
        PREWHERE push.ref = 'refs/heads/main'
        WHERE
            push.repository.full_name = 'pytorch/pytorch'
            AND tupleElement(head_commit, 'timestamp') >= window_start - toIntervalHour(1)
            AND tupleElement(head_commit, 'timestamp') < window_end + revert_window
        ORDER BY pushed_at, before_sha
        LIMIT 1 BY head
    )
),
revs AS (
    SELECT
        c.sha AS revert_sha, c.reverted_sha AS reverted_sha, c.reverted_pr AS reverted_pr, c.comment_id AS comment_id,
        c.comment_pr AS comment_pr, p.head AS revert_push, p.pushed_at AS reverted_at
    FROM (SELECT p, arrayJoin(p.members) AS c FROM (SELECT arrayJoin((SELECT pushes FROM push_arr)) AS p))
    WHERE c.reverted_sha != '' AND c.reverted_pr > 0
),
-- The -c of the mergebot command the revert commit links to; '' when none is found.
classes AS (
    SELECT
        id AS comment_id,
        extract(
            replaceRegexpOne(
                argMax(body, (updated_at, body)),
                '(?s)(?:-m|--message)[\\s =]+(?:"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|“[^”]*”)', ' '
            ),
            '(?s)@pytorch(?:merge|)bot\\s+revert.*?(?:-c|--classification)[\\s =]+["\']?'
            || '(nosignal|ignoredsignal|landrace|weird|ghfirst|autorevert)'
        ) AS revert_class
    FROM default.issue_comment
    WHERE (issue_url, id) IN (
        SELECT concat('https://api.github.com/repos/pytorch/pytorch/issues/', toString(comment_pr)), comment_id FROM revs
    )
    GROUP BY id
),
-- merges is keyed on PR and merge commit: a stack writes one merge_commit_sha for every member.
merge_heads AS (
    SELECT pr_num, merge_commit_sha, argMax(last_commit_sha, (comment_id, last_commit_sha)) AS head_sha
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
-- Per landing, its non-ghfirst reverts sorted by time and the next push before the first one.
cand AS (
    SELECT
        landing_sha, landed_at, closed, any(before_sha) AS before_sha, any(stack_size) AS stack_size,
        arraySort(groupArrayIf(tuple(reverted_at, revert_sha, reverted_pr, revert_push, reverted_sha, revert_class, pr_head),
            revert_class != 'ghfirst')) AS kept,
        arraySlice(arrayMap(p -> p.head, arraySort(p -> (p.pushed_at, p.head), arrayFilter(
            p -> p.pushed_at > landed_at AND p.pushed_at < tupleElement(kept[1], 'reverted_at'), (SELECT pushes FROM push_arr)
        ))), 1, 1) AS next_heads
    FROM (
        SELECT
            l.landing_sha AS landing_sha, l.landed_at AS landed_at, l.closed AS closed,
            any(l.before_sha) AS before_sha, any(l.stack_size) AS stack_size,
            r.reverted_at AS reverted_at, r.revert_sha AS revert_sha, r.reverted_pr AS reverted_pr,
            r.revert_push AS revert_push, r.reverted_sha AS reverted_sha, any(cl.revert_class) AS revert_class,
            maxIf(m.head_sha, m.merge_commit_sha = r.reverted_sha OR m.merge_commit_sha = l.landing_sha) AS merged_head,
            if(merged_head != '', merged_head, argMaxIf(w.head_sha, (w.created_at, w.head_sha), w.created_at < l.landed_at))
                AS pr_head
        FROM (
            SELECT
                p.head AS landing_sha, p.before_sha AS before_sha, p.pushed_at AS landed_at, p.closed AS closed,
                length(p.members) AS stack_size, tupleElement(arrayJoin(p.members), 'sha') AS member_sha
            FROM (SELECT arrayJoin((SELECT pushes FROM push_arr)) AS p)
            WHERE p.in_window
        ) AS l
        INNER JOIN revs AS r ON r.reverted_sha = l.member_sha
        LEFT JOIN classes AS cl ON cl.comment_id = r.comment_id
        LEFT JOIN merge_heads AS m ON m.pr_num = r.reverted_pr
        LEFT JOIN run_heads AS w ON w.pr = r.reverted_pr
        WHERE r.reverted_at >= l.landed_at AND r.reverted_at < l.landed_at + revert_window
        GROUP BY landing_sha, landed_at, closed, reverted_at, revert_sha, reverted_pr, revert_push, reverted_sha
    )
    GROUP BY landing_sha, landed_at, closed
),
-- Events (landings with a kept revert) and the count of ghfirst-only landings with a closed window.
ev_arr AS (
    SELECT tuple(events, ghfirst_only) AS ev
    FROM (
        SELECT
            groupArrayIf(tuple(landing_sha, landed_at, before_sha, stack_size, kept, next_heads, closed), notEmpty(kept))
                AS events,
            countIf(empty(kept) AND closed) AS ghfirst_only
        FROM cand
    )
),
-- Commits whose CI is read: L landing head, B its `before`, R last revert push, N next push,
-- P reverted PR heads (ord carries the PR number).
roles AS (
    SELECT
        e.landing_sha AS landing_sha, e.landed_at AS landed_at,
        CAST(arrayJoin(arrayConcat(
            [('L', 0, e.landing_sha), ('B', 0, e.before_sha), ('R', 0, tupleElement(e.kept[-1], 'revert_push'))],
            arrayMap((h, i) -> ('N', i, h), e.next_heads, arrayEnumerate(e.next_heads)),
            arrayMap(k -> ('P', k.reverted_pr, k.pr_head), arrayFilter(k -> k.pr_head != '', e.kept))
        )), 'Tuple(role String, ord Int64, sha String)') AS r,
        r.role AS role, r.ord AS ord, r.sha AS sha,
        arrayDistinct(arrayMap((pr, pr_head) -> (pr, pr_head), e.kept.reverted_pr, e.kept.pr_head)) AS event_prs
    FROM (SELECT arrayJoin(tupleElement((SELECT ev FROM ev_arr), 'events')) AS e)
),
ids_arr AS (
    SELECT groupArray(id) AS ids FROM materialized_views.workflow_job_by_head_sha WHERE head_sha IN (SELECT sha FROM roles)
),
-- Per (sha, shard-less config) of TD-workflow test jobs, each job id at its latest row: did every
-- shard complete; fails and cases of failed jobs; files failing in any job; shards.
state AS (
    SELECT
        head_sha AS sha, config, uniqExactIf(job_name, done) = uniqExact(job_name) AS completed,
        groupUniqArrayIf(tuple(test_file, run_id, run_attempt, created_at), test_file != '' AND failed) AS fails,
        groupUniqArrayIf(tuple(test_file, file, classname, name), test_file != '' AND failed) AS cases,
        groupUniqArrayIf(test_file, test_file != '') AS failed_files,
        groupUniqArray(tuple(id, job_name, success, created_at)) AS shards
    FROM (
        SELECT
            id, head_sha, run_id, run_attempt, name AS job_name, created_at,
            status = 'completed' AND conclusion IN ('success', 'failure') AS done,
            status = 'completed' AND conclusion = 'success' AS success, conclusion = 'failure' AS failed,
            splitByString(' / test (', name) AS name_parts,
            concat(workflow_name, ' / ', name_parts[1], ' / ', splitByString(', ', trimRight(name_parts[2], ')'))[1]) AS config
        FROM default.workflow_job
        PREWHERE id IN (SELECT i FROM (SELECT arrayJoin((SELECT ids FROM ids_arr)) AS i))
        WHERE
            startsWith(dynamoKey, 'pytorch/pytorch/') AND position(name, ' / test (') > 0
            AND (workflow_name IN {tdWorkflows: Array(String)}
                OR arrayExists(w -> startsWith(workflow_name, w), td_workflow_prefixes))
        ORDER BY _inserted_at DESC, status = 'completed' DESC, conclusion DESC
        LIMIT 1 BY id
    ) AS j
    LEFT JOIN (
        SELECT job_id, replaceAll(invoking_file, '.', '/') AS test_file, file, classname, name
        FROM default.failed_test_runs
        WHERE
            job_id IN (SELECT i FROM (SELECT arrayJoin((SELECT ids FROM ids_arr)) AS i))
            AND (failure.size0 > 0 OR error.size0 > 0) AND invoking_file != 'expected'
    ) AS f ON f.job_id = j.id
    GROUP BY sha, config
),
-- Breaking tests by (landing, config, test file): its probe cases (failing at the landing, real
-- ones first: ('', 'pytest', 'internal') is filed under any file), the event's PRs, and prs: the
-- config's PR-head shards created before the landing, failing files and all-green flag (every
-- shard's latest attempt succeeded).
brk_arr AS (
    SELECT groupArray(tuple(landing_sha, config, test_file, probes, landed_at, event_prs, prs, checked)) AS brk
    FROM (
        SELECT
            landing_sha, config, test_file, landed_at, event_prs, prs,
            arraySort(c -> (c.file = '', c), arrayFilter(c -> c.test_file = test_file, l.cases)) AS failing_cases,
            arraySlice(failing_cases, 1, greatest(1, least(5, arrayCount(c -> c.file != '', failing_cases)))) AS probes,
            row_number() OVER (PARTITION BY landing_sha ORDER BY config, test_file) <= 100 AS checked
        FROM (
            SELECT
                landing_sha, landed_at, config, event_prs, prs, l,
                arrayJoin(arrayFilter(
                    f -> b.completed AND NOT has(b.fails.test_file, f) AND NOT has(before_failed, f)
                    AND NOT (rv.completed AND has(rv.fails.test_file, f))
                    AND (has(n.fails.test_file, f) OR length(arrayDistinct(arrayMap(x -> (x.run_id, x.run_attempt),
                        arrayFilter(x -> x.test_file = f, l.fails)))) >= 2),
                    arrayDistinct(l.fails.test_file)
                )) AS test_file
            FROM (
                SELECT
                    landing_sha, landed_at, config, any(event_prs) AS event_prs,
                    groupArray(tuple(role, ord, completed, fails, cases, failed_files)) AS sts,
                    arrayFilter(x -> x.role = 'L', sts)[1] AS l,
                    arrayFilter(x -> x.role = 'B', sts)[1] AS b,
                    groupUniqArrayArray(if(arrayExists(m -> position(config, m) > 0, no_td_build_markers), [], b.failed_files))
                        OVER (PARTITION BY landing_sha) AS before_failed,
                    arrayFilter(x -> x.role = 'R', sts)[1] AS rv,
                    arraySort(x -> x.ord, arrayFilter(x -> x.role = 'N' AND x.completed, sts))[1] AS n,
                    groupArrayIf(tuple(pr, pr_shards, pr_failed, pr_green), role = 'P' AND notEmpty(pr_shards)) AS prs
                FROM (
                    SELECT
                        landing_sha, landed_at, event_prs, role, ord, ord AS pr, config, completed, fails, cases, failed_files,
                        arrayFilter(x -> x.created_at < landed_at, shards) AS pr_shards,
                        tupleElement(arrayFilter(x -> x.created_at < landed_at, fails), 'test_file') AS pr_failed,
                        arrayAll(x -> x.success
                            OR x.id != arrayMax(tupleElement(arrayFilter(u -> u.job_name = x.job_name, pr_shards), 'id')),
                            pr_shards) AS pr_green
                    FROM roles AS r INNER JOIN state AS s ON s.sha = r.sha
                )
                GROUP BY landing_sha, landed_at, config
            )
        )
    )
),
-- Every shard of a checked pair whose config is green at the PR head and whose file did not fail there.
green_shards AS (
    SELECT
        landing_sha, config, test_file, pr, s.id AS job_id, s.created_at AS created_at,
        s.id = arrayMax(tupleElement(arrayFilter(u -> u.job_name = s.job_name, shards), 'id')) AS latest
    FROM (
        SELECT b.landing_sha AS landing_sha, b.config AS config, b.test_file AS test_file, pe.pr AS pr,
            pe.pr_shards AS shards, arrayJoin(pe.pr_shards) AS s
        FROM (SELECT b, arrayJoin(b.prs) AS pe FROM (SELECT arrayJoin(brk) AS b FROM (SELECT (SELECT brk FROM brk_arr) AS brk)))
        WHERE b.checked AND pe.pr_green AND NOT has(pe.pr_failed, b.test_file)
    )
),
-- Did the file run in any shard; does every shard's latest attempt have test rows.
pres AS (
    SELECT landing_sha, config, test_file, pr, max(has(f.files, test_file)) AS ran, min(NOT latest OR f.job_id != 0) AS rows_ok
    FROM green_shards AS gs
    LEFT JOIN (
        SELECT job_id, groupUniqArray(replaceAll(invoking_file, '.', '/')) AS files
        FROM tests.all_test_runs
        WHERE (job_id, toDate(time_inserted)) IN (
            SELECT job_id, arrayJoin([toDate(created_at), toDate(created_at) + 1]) FROM green_shards
        )
        GROUP BY job_id
    ) AS f ON f.job_id = gs.job_id
    GROUP BY landing_sha, config, test_file, pr
),
-- One entry per (breaking test, PR of its event); 'candidate' is td_skipped or new_test, by age.
side_arr AS (
    SELECT groupArray(tuple(landing_sha, config, test_file, probes, landed_at, pr, side)) AS sides
    FROM (
        SELECT
            p.landing_sha AS landing_sha, p.config AS config, p.test_file AS test_file, probes, landed_at, p.pr AS pr,
            multiIf(
                pr_head = '', 'unknown',
                pe.pr != p.pr, 'config_not_on_pr',
                has(pe.pr_failed, p.test_file), 'failed_on_pr',
                NOT pe.pr_green, 'unknown',
                NOT checked, 'not_checked',
                ran, 'passed_on_pr',
                NOT rows_ok OR arrayExists(m -> position(p.config, m) > 0, no_td_build_markers), 'unknown',
                'candidate'
            ) AS side
        FROM (
            SELECT
                b.landing_sha AS landing_sha, b.config AS config, b.test_file AS test_file, b.probes AS probes,
                b.landed_at AS landed_at, b.checked AS checked, k.pr AS pr, k.pr_head AS pr_head,
                arrayFirst(x -> x.pr = k.pr, b.prs) AS pe
            FROM (SELECT b, arrayJoin(b.event_prs) AS k FROM (SELECT arrayJoin((SELECT brk FROM brk_arr)) AS b))
        ) AS p
        LEFT JOIN pres AS s
            ON s.landing_sha = p.landing_sha AND s.config = p.config AND s.test_file = p.test_file AND s.pr = p.pr
    )
),
-- (probe case, day) over each candidate's 3-day window. age_arr filters case and day apart: a
-- 4-tuple IN over all_test_runs_by_name's sort key reads ~7x slower.
probes AS (
    SELECT c.file AS file, c.classname AS classname, c.name AS name, day
    FROM (
        SELECT arrayJoin(x.probes) AS c, arrayJoin(arrayMap(i -> toDate(x.landed_at - new_test_age) - i, [0, 1, 2])) AS day
        FROM (SELECT arrayJoin(arrayFilter(x -> x.side = 'candidate', (SELECT sides FROM side_arr))) AS x)
    )
),
age_arr AS (
    SELECT groupArray(tuple(file, classname, name, day, first_seen)) AS ages
    FROM (
        SELECT file, classname, name, toDate(time_inserted) AS day, min(time_inserted) AS first_seen
        FROM tests.all_test_runs_by_name
        WHERE
            (file, classname, name) IN (SELECT file, classname, name FROM probes)
            AND toDate(time_inserted) IN (SELECT day FROM probes)
        GROUP BY file, classname, name, day
    )
),
-- One entry per event: its pairs sorted (the first 50 are shown), outcome and breaking tests. A
-- candidate is old (td_skipped) when any probe case ran in its window or the window predates
-- all_test_runs_by_name.
out_arr AS (
    SELECT groupArray(tuple(e, first_pairs, outcome, breaking_tests, td_skipped_any)) AS outs
    FROM (
        SELECT
            e, arraySlice(pairs, 1, 50) AS first_pairs, breaking_tests, has(pairs.outcome, 'td_skipped') AS td_skipped_any,
            tupleElement(arrayFilter(p -> p.outcome = 'passed_on_pr', pairs), 'test_file') AS passed_files,
            multiIf(
                tupleElement(e.kept[1], 'revert_class') = 'landrace', 'landrace',
                has(pairs.outcome, 'failed_on_pr'), 'signal_on_pr',
                arrayExists(p -> p.outcome = 'td_skipped' AND NOT has(passed_files, p.test_file), pairs), 'false_green',
                has(pairs.outcome, 'new_test'), 'new_test',
                has(pairs.outcome, 'passed_on_pr'), 'passed_on_pr',
                arrayAll(x -> x = 'config_not_on_pr', pairs.outcome), 'not_in_pr_matrix',
                'unknown'
            ) AS outcome
        FROM (SELECT arrayJoin(tupleElement((SELECT ev FROM ev_arr), 'events')) AS e, e.landing_sha AS landing_sha) AS v
        LEFT JOIN (
            SELECT
                landing_sha, arraySort(groupArray(tuple(config, test_file, pr, outcome))) AS pairs,
                uniqExact(config, test_file) AS breaking_tests
            FROM (
                SELECT
                    x.landing_sha AS landing_sha, x.config AS config, x.test_file AS test_file, x.pr AS pr,
                    if(x.side != 'candidate', x.side, if(
                        (SELECT min(time_inserted) FROM tests.all_test_runs_by_name) > x.landed_at - new_test_age
                        OR arrayExists(
                            a -> arrayExists(c -> (c.file, c.classname, c.name) = (a.file, a.classname, a.name), x.probes)
                            AND a.day >= toDate(x.landed_at - new_test_age) - 2 AND a.first_seen <= x.landed_at - new_test_age,
                            ages
                        ), 'td_skipped', 'new_test'
                    )) AS outcome
                FROM (SELECT arrayJoin((SELECT sides FROM side_arr)) AS x, (SELECT ages FROM age_arr) AS ages)
            )
            GROUP BY landing_sha
        ) AS t ON t.landing_sha = v.landing_sha
    )
)

-- Output row i = 0 is the total row: o is then the event entry's default (1970, '', empty
-- arrays, as the total row shows), and only that row keeps outs and ce (closed events).
SELECT
    if(i = 0, 'total', 'event') AS grain, o.e.landed_at AS landed_at, o.e.landing_sha AS landing_sha,
    arraySort(arrayDistinct(o.e.kept.reverted_pr)) AS reverted_prs, o.e.kept.revert_sha AS revert_shas,
    tupleElement(o.e.kept[1], 'reverted_at') AS reverted_at, tupleElement(o.e.kept[1], 'revert_class') AS revert_class,
    toUInt32(o.e.stack_size) AS stack_size, o.outcome AS outcome, toUInt8(o.e.closed) AS window_closed,
    toUInt64(o.breaking_tests) AS breaking_tests, o.first_pairs.config AS test_configs,
    o.first_pairs.test_file AS test_files, o.first_pairs.pr AS test_prs, o.first_pairs.outcome AS test_outcomes,
    if(i = 0, arraySum(p -> if(p.in_window AND p.closed, arrayCount(c -> c.landed_pr > 0, p.members), 0),
        (SELECT pushes FROM push_arr)), 0) AS landed_prs,
    toUInt64(length(ce)) AS events, countEqual(ce.outcome, 'false_green') AS false_green,
    countEqual(ce.outcome, 'signal_on_pr') AS signal_on_pr, countEqual(ce.outcome, 'passed_on_pr') AS passed_on_pr,
    countEqual(ce.outcome, 'new_test') AS new_test, countEqual(ce.outcome, 'not_in_pr_matrix') AS not_in_pr_matrix,
    countEqual(ce.outcome, 'landrace') AS landrace, countEqual(ce.outcome, 'unknown') AS unknown,
    toUInt64(arrayCount(ce.td_skipped_any)) AS td_skipped_any,
    toUInt64(arrayCount(x -> x.e.closed AND empty(x.first_pairs), outs)) AS other_reverts,
    if(i = 0, toUInt64(tupleElement((SELECT ev FROM ev_arr), 'ghfirst_only')), 0) AS ghfirst_reverts
FROM (
    SELECT
        arrayJoin(arrayConcat([0], arrayEnumerate(evs))) AS i, evs[i] AS o,
        if(i = 0, all_outs, []) AS outs, arrayFilter(x -> x.e.closed AND notEmpty(x.first_pairs), outs) AS ce
    FROM (
        SELECT
            all_outs, arraySlice(arrayReverseSort(x -> (x.e.landed_at, x.e.landing_sha),
                arrayFilter(x -> notEmpty(x.first_pairs), all_outs)), 1, 1000) AS evs
        FROM (SELECT (SELECT outs FROM out_arr) AS all_outs)
    )
)
SETTINGS max_execution_time = 60, max_threads = 8, allow_experimental_analyzer = 1, enable_named_columns_in_function_tuple = 1
