-- Of the PRs GreenLight evaluated and that then landed, how many carried a GreenLight LAND
-- and no human approval at all.
--
-- Two denominators, because the narrow one is a screenshot hazard on its own: pct_gl_only is
-- the share of GreenLight-evaluated merges, pct_of_all_merges the share of every merge in the
-- window. Only the second answers "how much of the repo does GreenLight authorise". Both rates
-- are NULL rather than zero when their denominator is empty, so the UI can tell "nothing merged"
-- apart from "nothing merged on GreenLight's authority"; the counts they divide are returned
-- alongside them for the same reason.
--
-- window_end clamps down to now: the page snaps stopTime up to the end of the next bucket, so it
-- is always in the future, and a far-future value overflows the DateTime64 comparison against
-- head_commit.timestamp outright. window_start clamps up to the ledger's first row, because
-- GreenLight cannot hold a verdict from before its ledger existed. ledger_start falls back to now
-- for a repo with no ledger rows at all: min() over an empty set returns the epoch rather than
-- NULL, and an epoch window_start unbounds the default.push scan.
--
-- Merges come from main-branch commit titles rather than default.merges: a ghstack stack lands
-- as a single push whose non-final commits appear only in `commits`, and those stack members
-- have no row in default.merges at all.
--
-- The approval gate is the moment mergebot was told to merge, not the merge commit's timestamp.
-- A commit timestamp is written when the rebase finishes, minutes to hours after mergebot read
-- the approvals, so an approval arriving inside that gap gets credited with authorising a merge
-- it could not have influenced. default.merges carries no timestamp of its own, hence the hop
-- through the mergebot comment.
--
-- The gate takes the LAST command at or before the merge, not the first: a PR that was reverted
-- and re-landed has several successful default.merges rows, and its earliest one belongs to a
-- merge that is not the one being scored here. Stack members have no default.merges row at all
-- and fall back to the commit timestamp, as does any merge whose command predates the window.
--
-- Do not simplify this to the ARRAY JOIN clause: under sqlfluff 3.3.0's clickhouse dialect a
-- following WHERE/GROUP BY/LIMIT is swallowed as its alias, costing this file all lint coverage.
--
-- merged_prs is read exactly once on purpose. A named subquery is re-executed at every reference
-- rather than materialised, and this one is the push scan that dominates the query, so narrowing
-- the review or merge-command reads to the merged set would cost more than the rows it saves:
-- both are filtered to the repo only, and the LEFT JOINs discard whatever does not belong.
--
-- Bots are excluded by login, not by review.user.type: pytorchbot approves as type 'User', so
-- the type field misses the account that matters. The list mirrors BOT_LOGINS in
-- greenlight/src/greenlight/pr_hash.py; the trailing-'[bot]' test covers the GitHub App
-- accounts, GreenLight's own pytorchgreenlight[bot] among them.
WITH
(
    SELECT if(min(version) > toDateTime64(0, 3), min(version), now64(3))
    FROM misc.greenlight_pr_state
    WHERE repo = {repo: String}
) AS ledger_start,
greatest({startTime: DateTime64(3)}, ledger_start) AS window_start,
least({stopTime: DateTime64(3)}, now64(3)) AS window_end,
[
    'pytorchbot',
    'pytorch-bot',
    'pytorchmergebot',
    'pytorchupdatebot',
    'github-actions',
    'dependabot',
    'facebook-github-bot',
    'facebook-github-tools',
    'meta-codesync',
    'codecov',
    'codecov-commenter',
    'linux-foundation-easycla'
] AS bot_logins,

merged_prs AS (
    SELECT
        toInt64OrZero(
            extract(splitByChar('\n', message)[1], '\\(#(\\d+)\\)\\s*$')
        ) AS pr_number,
        min(committed_at) AS merged_at
    FROM (
        SELECT
            tupleElement(c, 1) AS message,
            toDateTime64(tupleElement(c, 2), 3) AS committed_at
        FROM (
            SELECT
                arrayJoin(
                    arrayZip(commits.message, commits.timestamp)
                ) AS c
            FROM default.push
            WHERE
                push.ref IN ('refs/heads/main', 'refs/heads/master')
                AND push.repository.full_name = {repo: String}
                AND push.head_commit.timestamp >= window_start
                AND push.head_commit.timestamp < window_end + toIntervalDay(1)
        )
    )
    WHERE
        committed_at >= window_start
        AND committed_at < window_end
        AND message NOT LIKE 'Revert %'
        AND message NOT LIKE 'Back out%'
        AND match(splitByChar('\n', message)[1], '\\(#\\d+\\)\\s*$')
    GROUP BY pr_number
),

merge_commands AS (
    SELECT
        m.pr_num AS pr_number,
        ic.created_at AS commanded_at
    FROM default.merges AS m
    INNER JOIN (
        SELECT
            id,
            created_at
        FROM default.issue_comment
        WHERE
            created_at >= window_start - toIntervalDay(30)
            AND created_at < window_end + toIntervalDay(1)
    ) AS ic ON m.comment_id = ic.id
    WHERE
        m.owner = splitByChar('/', {repo: String})[1]
        AND m.project = splitByChar('/', {repo: String})[2]
        AND NOT m.is_failed
        AND NOT m.dry_run
),

terminal_verdicts AS (
    SELECT
        pr_number,
        status,
        version
    FROM misc.greenlight_pr_state
    WHERE repo = {repo: String} AND status IN ('LAND', 'NO_LAND')
),

scored_merges AS (
    SELECT
        m.pr_number AS pr_number,
        any(m.merged_at) AS merged_at,
        argMaxIf(v.status, v.version, v.version <= m.merged_at) AS verdict
    FROM merged_prs AS m
    LEFT JOIN terminal_verdicts AS v ON m.pr_number = v.pr_number
    GROUP BY m.pr_number
),

gated_merges AS (
    SELECT
        s.pr_number AS pr_number,
        s.verdict AS verdict,
        maxIf(
            d.commanded_at, d.commanded_at <= s.merged_at
        ) AS commanded_at,
        if(
            commanded_at > toDateTime64(0, 3), commanded_at, s.merged_at
        ) AS approval_cutoff
    FROM scored_merges AS s
    LEFT JOIN merge_commands AS d ON s.pr_number = d.pr_number
    GROUP BY s.pr_number, s.verdict, s.merged_at
),

reviews AS (
    SELECT
        pull_request.number AS pr_number,
        review.id AS review_id,
        min(review.submitted_at) AS submitted_at,
        max(action = 'dismissed') AS dismissed,
        max(
            action = 'submitted' AND review.state = 'approved'
        ) AS is_approval,
        max(
            lower(review.user.login) IN bot_logins
            OR endsWith(lower(review.user.login), '[bot]')
        ) AS is_bot
    FROM default.pull_request_review
    WHERE
        pull_request_review.repository.full_name = {repo: String}
    GROUP BY pull_request.number, review.id
),

human_approvals AS (
    SELECT
        pr_number,
        submitted_at
    FROM reviews
    WHERE is_approval AND NOT dismissed AND NOT is_bot
),

scored AS (
    SELECT
        e.pr_number AS pr_number,
        any(e.verdict) AS verdict,
        max(
            a.submitted_at > toDateTime64(0, 3)
            AND a.submitted_at <= e.approval_cutoff
        ) AS has_human_approval
    FROM gated_merges AS e
    LEFT JOIN human_approvals AS a ON e.pr_number = a.pr_number
    GROUP BY e.pr_number
)

SELECT
    merged_evaluated_prs,
    gl_only,
    if(
        merged_evaluated_prs = 0,
        NULL,
        round(100. * gl_only / merged_evaluated_prs, 2)
    ) AS pct_gl_only,
    human_approved,
    no_approval,
    merged_prs_total,
    if(
        merged_prs_total = 0,
        NULL,
        round(100. * gl_only / merged_prs_total, 2)
    ) AS pct_of_all_merges
FROM (
    SELECT
        countIf(verdict != '') AS merged_evaluated_prs,
        countIf(verdict = 'LAND' AND NOT has_human_approval) AS gl_only,
        countIf(verdict != '' AND has_human_approval) AS human_approved,
        countIf(
            verdict != '' AND verdict != 'LAND' AND NOT has_human_approval
        ) AS no_approval,
        count() AS merged_prs_total
    FROM scored
)
