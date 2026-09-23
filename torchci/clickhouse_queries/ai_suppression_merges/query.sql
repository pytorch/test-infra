-- Merges that only landed because the AI advisor cleared their failures, each with what happened
-- next. Drives every tile, the weekly chart and the table on /metrics/ai_suppression.
--
-- The cohort is a landed, non-force bot merge whose default.merges row carries a non-empty
-- ai_not_related_checks. trymerge files a failed check there only when no other Dr.CI category
-- (unstable, broken trunk, flaky, invalid cancel, CRCR L3) excused it and the author did not list
-- it under `merge -i`, so without the AI every one of these merges would have been blocked.
--
-- Three outcomes are measured per merge, all against the commits of the push that landed it, so a
-- ghstack stack counts as one merge and a revert of any member counts against it:
--   * reverted: a revert commit ("This reverts commit <sha>") of one of those commits, landed
--     within {revertWindowDays} days of the merge. A `-c ghfirst` revert is an internal-first
--     rollback, not a CI verdict, so it is reported (ghfirst_reverted) but never counts here.
--   * attributed: the revert plausibly came from a cleared signal. Either autorevert reverted it
--     on a job-level signal matching a cleared job, or a human reverted it with
--     `-c ignoredsignal`. Everything else is unattributed, not clean. autorevert records a
--     test-level signal by its test id, which names no job, so a revert decided only on
--     test-level signals is unattributed even when the failing test ran in a cleared job.
--   * trunk_red: a cleared job failed on the merge commit on main while the same job passed on
--     the commit main was at just before the merge landed (the push's `before`). A job already red
--     there is pre-existing breakage, not a miss.
--
-- The *_total columns are window totals, identical on every row and computed before the row
-- limit, which sits far above any plausible volume; the page says so if it is ever reached.
-- Revert rates are taken over merges whose revert window has closed, for the cohort and for
-- every other landed merge alike, so the two rates are comparable. The *_incl_ghfirst_total
-- variants also count merges whose only revert was `-c ghfirst`. A window with no cleared
-- merges still returns one row (merged_sha = '') carrying the totals, as long as anything landed;
-- callers drop it from tables.
--
-- The grain is one landing push. default.merges has no timestamp, so merge time comes from the
-- push itself (repository.pushed_at) and the title from the head commit of the main-branch push
-- whose head is merge_commit_sha. Rarely (89 of 43,833 pytorch/pytorch merge commits as of
-- 2026-09-23) two merge commands record the same merge_commit_sha; their rows are folded into
-- one landing, so it counts once.
WITH
    {startTime: DateTime64(3)} AS window_start,
    least({stopTime: DateTime64(3)}, now64(3)) AS window_end,
    toIntervalDay({revertWindowDays: UInt32}) AS revert_window,
    toIntervalHour(1) AS push_slack,
-- Deliberately not bounded to the window: default.merges holds ~70k rows in all, and bounding it
-- by `merge_commit_sha IN (SELECT push_head FROM main_pushes)` adds a default.push read to every
-- inlined evaluation (measured 2026-09-23, 21-day window: 2.07M rows read unbounded, 3.11M
-- bounded, identical results).
merge_rows AS (
    SELECT
        merge_commit_sha,
        argMax(pr_num, last_comment_id) AS pr_num,
        argMax(author, last_comment_id) AS author,
        -- Each cleared check as (name, url, PR head it was cleared on).
        arrayFlatten(groupArray(ai_checks)) AS ai_checks
    FROM (
        -- Latest record per PR and landing, then folded per landing.
        SELECT
            pr_num,
            merge_commit_sha,
            max(comment_id) AS last_comment_id,
            argMax(author, comment_id) AS author,
            argMax(last_commit_sha, comment_id) AS head_sha,
            arrayMap(c -> (c[1], c[2], head_sha), argMax(ai_not_related_checks, comment_id))
                AS ai_checks
        FROM default.merges
        WHERE
            owner = splitByChar('/', {repo: String})[1]
            AND project = splitByChar('/', {repo: String})[2]
            AND NOT is_failed
            AND NOT dry_run
            AND NOT skip_mandatory_checks
            AND merge_commit_sha != ''
        GROUP BY pr_num, merge_commit_sha
    )
    GROUP BY merge_commit_sha
),
main_pushes AS (
    SELECT
        head_commit.id AS push_head,
        -- The push's own time, not a commit timestamp: a commit can be authored or prepared
        -- long before it lands. The scan is bounded on the head commit timestamp and the window
        -- is then enforced on pushed_at. Over 8,750 pytorch/pytorch main pushes in the 180 days
        -- to 2026-09-22 the head commit preceded its push by 0 to 129 s (p99.9 17 s), never
        -- followed it: so the lower bound is widened by push_slack (an hour, far past 129 s) and
        -- the upper bound needs none. The bound is spelled tupleElement(head_commit, 'timestamp')
        -- because that is the sorting key expression verbatim: the subcolumn form is not
        -- recognised by the key condition and reads every granule (measured 2026-09-23 over a
        -- 21-day window: 2.45M rows as a subcolumn, 80k as tupleElement).
        if(
            repository.pushed_at > 0,
            toDateTime64(repository.pushed_at, 3),
            toDateTime64(head_commit.timestamp, 3)
        ) AS pushed_at,
        replaceRegexpOne(
            splitByChar('\n', head_commit.message)[1], '\\s*\\(#\\d+\\)\\s*$', ''
        ) AS head_title,
        -- Where main stood immediately before this push landed: the true pre-merge state.
        -- merges.merge_base_sha is the PR's GitHub merge base instead, which can be far older.
        before AS before_sha,
        commits.id AS commit_shas
    FROM default.push
    PREWHERE push.ref IN ('refs/heads/main', 'refs/heads/master')
    WHERE
        push.repository.full_name = {repo: String}
        AND tupleElement(head_commit, 'timestamp') >= window_start - push_slack
        AND tupleElement(head_commit, 'timestamp') < window_end
    LIMIT 1 BY push_head
),
landed AS (
    SELECT
        m.pr_num AS pr_num,
        m.author AS author,
        p.head_title AS title,
        m.merge_commit_sha AS merged_sha,
        p.before_sha AS base_sha,
        m.ai_checks AS ai_checks,
        length(m.ai_checks) > 0 AS cleared,
        p.pushed_at AS merged_at,
        p.commit_shas AS commit_shas,
        p.pushed_at + revert_window <= now64(3) AS window_closed
    FROM merge_rows AS m
    INNER JOIN main_pushes AS p ON m.merge_commit_sha = p.push_head
    WHERE p.pushed_at >= window_start AND p.pushed_at < window_end
),
reverts AS (
    SELECT
        tupleElement(c, 1) AS revert_sha,
        pushed AS reverted_at,
        extract(tupleElement(c, 2), 'This reverts commit ([0-9a-f]{40})') AS reverted_sha,
        extract(
            tupleElement(c, 2), 'on behalf of https://github\\.com/([A-Za-z0-9._-]+)'
        ) AS reverter,
        toInt64OrZero(
            extract(tupleElement(c, 2), 'Reverted https://github\\.com/[^/]+/[^/]+/pull/(\\d+)')
        ) AS reverted_pr,
        toInt64OrZero(
            extract(tupleElement(c, 2), '#issuecomment-(\\d+)\\)\\)')
        ) AS trigger_comment_id
    FROM (
        SELECT
            arrayJoin(arrayZip(commits.id, commits.message, commits.timestamp)) AS c,
            if(
                repository.pushed_at > 0,
                toDateTime64(repository.pushed_at, 3),
                toDateTime64(head_commit.timestamp, 3)
            ) AS pushed
        FROM default.push
        PREWHERE push.ref IN ('refs/heads/main', 'refs/heads/master')
        WHERE
            push.repository.full_name = {repo: String}
            AND tupleElement(head_commit, 'timestamp') >= window_start - push_slack
            AND tupleElement(head_commit, 'timestamp') < window_end + revert_window
    )
    WHERE
        (tupleElement(c, 2) LIKE 'Revert %' OR tupleElement(c, 2) LIKE 'Back out%')
        AND reverted_sha != ''
),
revert_classes AS (
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
        ) AS classification
    FROM default.issue_comment
    WHERE
        issue_url IN (
            SELECT concat('https://api.github.com/repos/', {repo: String}, '/issues/', toString(reverted_pr))
            FROM reverts
            WHERE reverted_pr > 0
        )
        AND id IN (SELECT trigger_comment_id FROM reverts WHERE trigger_comment_id > 0)
    GROUP BY id
),
member_reverts AS (
    SELECT
        l.merged_sha AS merged_sha,
        l.merged_at AS merged_at,
        r.revert_sha AS revert_sha,
        r.reverted_at AS reverted_at,
        r.reverted_sha AS reverted_sha,
        r.reverter AS reverter,
        rc.classification AS classification
    FROM (
        SELECT merged_sha, merged_at, arrayJoin(commit_shas) AS member_sha
        FROM landed
    ) AS l
    INNER JOIN reverts AS r ON r.reverted_sha = l.member_sha
    LEFT JOIN revert_classes AS rc ON r.trigger_comment_id = rc.comment_id
    WHERE r.reverted_at >= l.merged_at AND r.reverted_at < l.merged_at + revert_window
),
-- One row per autorevert decision, with its time, so a signal is credited only to the revert that
-- decision produced, not to any other revert of the same commit.
autoreverts AS (
    SELECT
        commit_sha,
        ts,
        arrayMap(k -> replaceRegexpOne(k, ' \\[[a-z]+\\]$', ''), source_signal_keys) AS signal_jobs
    FROM misc.autorevert_events_v2
    WHERE
        repo = {repo: String}
        AND action = 'revert'
        AND dry_run = 0
        AND failed = 0
        -- A time bound, not `commit_sha IN (SELECT ... FROM member_reverts)`: that would evaluate
        -- member_reverts (and the push and issue_comment reads under it) a second time. The
        -- table is partitioned by month of ts, and the LEFT JOIN in revert_outcomes restricts.
        AND ts >= toDateTime(window_start)
        AND ts < toDateTime(window_end) + revert_window
),
-- One row per cleared check. job_key is the check name in autorevert's signal shape, mirroring
-- JobRow.base_name in aws/lambda/pytorch-auto-revert/pytorch_auto_revert/signal_extraction_types.py:
-- drop the workflow prefix, drop every parenthetical group, then re-append the config (the first
-- token before a comma inside any parenthetical), e.g. "macos-py3-arm64 / test (default)".
--
-- ClickHouse inlines a CTE at every reference, so each reference below re-runs this one (and
-- `landed` under it): verdicts (twice), trunk_requests, checks_detail and merge_job_keys. Keep
-- what it reads cheap and count before adding a reference.
cleared_checks AS (
    SELECT
        merged_sha,
        merged_at,
        base_sha,
        check.1 AS check_name,
        check.2 AS check_url,
        check.3 AS head_sha,
        replaceRegexpOne(check_name, '^[^/]+ / ', '') AS job_name,
        trimBoth(extract(job_name, '\\(([^,()]+),')) AS job_config,
        concat(
            trimBoth(replaceRegexpAll(replaceRegexpAll(job_name, '\\s*\\([^()]*\\)', ''), '\\s+', ' ')),
            if(job_config = '', '', concat(' (', job_config, ')'))
        ) AS job_key
    FROM landed
    ARRAY JOIN ai_checks AS check
    WHERE cleared
),
-- The cleared job keys per landing, for revert attribution. Kept apart from checks_detail so
-- revert_outcomes does not re-run the verdict and workflow_job reads just to get these names.
merge_job_keys AS (
    SELECT merged_sha, groupArray(job_key) AS job_keys
    FROM cleared_checks
    GROUP BY merged_sha
),
-- The advisor verdict that was live when the merge landed; a later re-run of the advisor on the
-- same head must not rewrite the explanation of a decision already taken.
verdicts AS (
    SELECT
        c.merged_sha AS merged_sha,
        c.check_name AS check_name,
        c.head_sha AS head_sha,
        argMax(v.verdict, v.timestamp) AS verdict,
        argMax(v.confidence, v.timestamp) AS confidence,
        argMax(v.summary, v.timestamp) AS summary
    FROM cleared_checks AS c
    INNER JOIN (
        SELECT suspect_commit, signal_key, verdict, confidence, summary, timestamp
        FROM misc.autorevert_advisor_verdicts
        WHERE
            repo = {repo: String}
            AND startsWith(signal_key, 'dr_ci_')
            AND suspect_commit IN (SELECT head_sha FROM cleared_checks)
    ) AS v ON v.suspect_commit = c.head_sha AND v.signal_key = concat('dr_ci_', c.check_name)
    WHERE v.timestamp <= c.merged_at
    GROUP BY c.merged_sha, c.check_name, c.head_sha
),
-- A cleared job as it ran on main: on the merge commit, and on the commit before it for comparison.
-- Job ids grow over time, including across re-runs, so the highest id among completed attempts is
-- the latest result; an attempt still running does not displace it. The filter is on status, not
-- on an empty conclusion: conclusion_kg (keep-going) can already read 'failure' while the job is
-- still in progress. The
-- latest result is deliberate: a failure that passes when re-run on the same commit is flaky, not
-- breakage the AI missed, so it must not count as newly red.
trunk_requests AS (
    SELECT merged_sha, check_name, request.1 AS role, request.2 AS sha
    FROM cleared_checks
    ARRAY JOIN [('merge', merged_sha), ('base', base_sha)] AS request
),
trunk_status AS (
    SELECT
        r.merged_sha AS merged_sha,
        r.check_name AS check_name,
        argMaxIf(j.conclusion, j.id, r.role = 'merge' AND j.status = 'completed') AS merge_conclusion,
        argMaxIf(j.conclusion, j.id, r.role = 'base' AND j.status = 'completed') AS base_conclusion
    FROM trunk_requests AS r
    INNER JOIN (
        SELECT
            job.id AS id,
            job.head_sha AS head_sha,
            concat(job.workflow_name, ' / ', job.name) AS check_name,
            job.status AS status,
            job.conclusion_kg AS conclusion
        FROM default.workflow_job AS job FINAL
        WHERE
            job.id IN (
                SELECT id
                FROM materialized_views.workflow_job_by_head_sha
                WHERE head_sha IN (SELECT sha FROM trunk_requests)
            )
            AND job.repository_full_name = {repo: String}
    ) AS j ON j.head_sha = r.sha AND j.check_name = r.check_name
    GROUP BY r.merged_sha, r.check_name
),
checks_detail AS (
    SELECT
        c.merged_sha AS merged_sha,
        groupArray(
            tuple(
                c.check_name,
                c.check_url,
                if(v.merged_sha = '', '', toString(v.verdict)),
                v.confidence,
                v.summary,
                t.merge_conclusion,
                t.base_conclusion
            )
        ) AS checks,
        countIf(
            t.merge_conclusion IN ('failure', 'timed_out') AND t.base_conclusion = 'success'
        ) > 0 AS trunk_red
    FROM cleared_checks AS c
    LEFT JOIN verdicts AS v
        ON c.merged_sha = v.merged_sha AND c.check_name = v.check_name AND c.head_sha = v.head_sha
    LEFT JOIN trunk_status AS t
        ON c.merged_sha = t.merged_sha AND c.check_name = t.check_name
    GROUP BY c.merged_sha
),
-- One row per revert of a merge, with whether it counts (not ghfirst) and whether it is attributed
-- to a cleared signal: `-c ignoredsignal`, or an autorevert whose own decision -- made between the
-- merge and this revert -- named a job matching a cleared check.
revert_outcomes AS (
    SELECT
        mr.merged_sha AS merged_sha,
        mr.revert_sha AS revert_sha,
        mr.reverted_at AS reverted_at,
        mr.reverter AS reverter,
        mr.classification AS classification,
        mr.classification != 'ghfirst' AS counts,
        counts
            AND (
                classification = 'ignoredsignal'
                OR countIf(
                    mr.reverter = 'pytorch-auto-revert'
                    AND ar.ts >= mr.merged_at
                    AND ar.ts <= mr.reverted_at
                    AND hasAny(ar.signal_jobs, d.job_keys)
                ) > 0
            ) AS attributed
    FROM member_reverts AS mr
    LEFT JOIN merge_job_keys AS d ON mr.merged_sha = d.merged_sha
    LEFT JOIN autoreverts AS ar ON mr.reverted_sha = ar.commit_sha
    GROUP BY mr.merged_sha, mr.revert_sha, mr.reverted_at, mr.reverter, mr.classification
),
merge_outcomes AS (
    SELECT
        l.pr_num AS pr_num,
        l.author AS author,
        l.title AS title,
        l.merged_sha AS merged_sha,
        l.merged_at AS merged_at,
        l.cleared AS cleared,
        l.window_closed AS window_closed,
        d.checks AS checks,
        d.trunk_red AS trunk_red,
        countIf(ro.revert_sha != '' AND ro.counts) > 0 AS reverted,
        countIf(ro.revert_sha != '' AND NOT ro.counts) > 0 AS ghfirst_reverted,
        countIf(ro.revert_sha != '' AND ro.attributed) > 0 AS attributed,
        -- The revert shown is the one that decided the row: the earliest attributed revert, else
        -- the earliest counting revert, else the earliest ghfirst one.
        argMinIf(
            tuple(ro.revert_sha, ro.reverted_at, ro.reverter, ro.classification),
            tuple(multiIf(ro.attributed, 0, ro.counts, 1, 2), ro.reverted_at),
            ro.revert_sha != ''
        ) AS shown_revert,
        shown_revert.1 AS revert_sha,
        shown_revert.2 AS reverted_at,
        shown_revert.3 AS reverter,
        shown_revert.4 AS classification
    FROM landed AS l
    LEFT JOIN checks_detail AS d ON l.merged_sha = d.merged_sha
    LEFT JOIN revert_outcomes AS ro ON l.merged_sha = ro.merged_sha
    GROUP BY
        l.pr_num, l.author, l.title, l.merged_sha, l.merged_at, l.cleared, l.window_closed,
        d.checks, d.trunk_red
),
-- Window totals are computed over every landed merge in one pass (a CTE referenced twice is
-- evaluated twice), then only the cleared merges are kept. When there are none, the first row
-- survives as a carrier for the totals, with its per-merge fields blanked.
windowed AS (
    SELECT
        *,
        row_number() OVER () AS rn,
        count() OVER () AS merges_total,
        countIf(cleared) OVER () AS cleared_merges_total,
        sumIf(length(checks), cleared) OVER () AS cleared_checks_total,
        countIf(cleared AND window_closed) OVER () AS cleared_closed_total,
        countIf(cleared AND window_closed AND reverted) OVER () AS cleared_reverted_total,
        countIf(cleared AND window_closed AND (reverted OR ghfirst_reverted)) OVER ()
            AS cleared_reverted_incl_ghfirst_total,
        countIf(cleared AND attributed) OVER () AS cleared_attributed_total,
        countIf(cleared AND trunk_red) OVER () AS cleared_trunk_red_total,
        countIf(NOT cleared AND window_closed) OVER () AS other_closed_total,
        countIf(NOT cleared AND window_closed AND reverted) OVER () AS other_reverted_total,
        countIf(NOT cleared AND window_closed AND (reverted OR ghfirst_reverted)) OVER ()
            AS other_reverted_incl_ghfirst_total
    FROM merge_outcomes
)

SELECT
    if(cleared, pr_num, 0) AS pr_number,
    if(cleared, title, '') AS title,
    if(cleared, author, '') AS author,
    if(cleared, merged_sha, '') AS merged_sha,
    if(cleared, merged_at, NULL) AS merged_at,
    if(cleared, checks, []) AS checks,
    cleared AND trunk_red AS trunk_red,
    cleared AND window_closed AS window_closed,
    cleared AND reverted AS reverted,
    cleared AND ghfirst_reverted AS ghfirst_reverted,
    if(cleared, revert_sha, '') AS revert_sha,
    if(cleared AND revert_sha != '', reverted_at, NULL) AS reverted_at,
    if(cleared, reverter, '') AS reverter,
    if(cleared, classification, '') AS revert_classification,
    cleared AND attributed AS attributed,
    merges_total,
    cleared_merges_total,
    cleared_checks_total,
    cleared_closed_total,
    cleared_reverted_total,
    cleared_reverted_incl_ghfirst_total,
    cleared_attributed_total,
    cleared_trunk_red_total,
    other_closed_total,
    other_reverted_total,
    other_reverted_incl_ghfirst_total
FROM windowed
WHERE cleared OR (cleared_merges_total = 0 AND rn = 1)
ORDER BY merged_at DESC, pr_number ASC
LIMIT 10000
