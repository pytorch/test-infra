-- Reverts landed on the default branch, each joined to the GreenLight verdict that was live
-- for the version being reverted. Drives both the revert-trust rate and the reverted-PR table.
--
-- Rows whose pr_number is 0 are reverts that could not be resolved back to a PR. They are
-- returned rather than filtered so the count survives a window in which every revert is
-- unattributable.
--
-- A window with no reverts at all still returns one row, joined in from window_anchor and
-- identified by revert_sha = ''. Every count here rides on a row, so without it a quiet day --
-- the best outcome the metric can report -- comes back as no rows and renders as missing data
-- beside a coverage strip that is full. The caller drops that row from any table it renders and
-- reads the counts, which are zero, and evaluated_prs_total, which is not.
--
-- resolvable_reverts and attributable_reverts are different cuts and neither is a synonym for
-- the other. resolvable_reverts counts every revert resolved to a PR; attributable_reverts
-- counts only those that also survive the ghfirst exclusion, which is what the rate is a share
-- of. Naming the second one alone as "resolvable to a PR" understates the population by however
-- many ghfirst reverts the window held.
--
-- land_approved_ghfirst_reverts is the rest of that same split: reverts of a version GreenLight
-- approved that the ghfirst exclusion removed from land_approved_reverts. The two sum to every
-- LAND revert resolved to a PR. It is a window count rather than something a caller subtracts
-- from the returned rows, because the rows are cut by the row limit and the counts are not --
-- a caller deriving it from rows would watch its figure shrink while the rate it explains held.
--
-- The *_reverts columns are window totals: identical on every row, and computed before the row
-- limit, so a truncated result still reports exact counts for the whole window. Counting the
-- returned rows instead would shrink the revert rate's numerator and denominator together once
-- the limit bites, while the tile still claimed to cover every revert in the window.
--
-- window_end clamps down to now: the page snaps stopTime up to the end of the next bucket, so it
-- is always in the future, and a far-future value overflows the DateTime64 comparison against
-- head_commit.timestamp outright. window_start clamps up to the ledger's first row, because
-- GreenLight cannot hold a verdict from before its ledger existed. ledger_start falls back to now
-- for a repo with no ledger rows at all: min() over an empty set returns the epoch rather than
-- NULL, and an epoch window_start unbounds the default.push scan.
--
-- evaluated_prs_total is the denominator of the revert rate: distinct PRs GreenLight evaluated
-- over the same window, and the same population clickhouse_queries/greenlight_quality_coverage
-- reports as prs_evaluated, so the two tiles cannot disagree. The two are spelled differently
-- and equal by construction: that query groups the window by pr_number and keeps every group
-- whose max(status != 'REVERTED') is 1, this one counts distinct pr_number over the rows
-- satisfying that same predicate, and both are "PRs holding at least one non-REVERTED row in
-- the window". REVERTED is excluded because GreenLight's revert guard writes that marker
-- against PRs it never reviewed. The count spans every evaluated PR, including PRs that never
-- merged and so could never have been reverted.
--
-- Merges come from main-branch commit titles rather than default.merges: a ghstack stack lands
-- as a single push whose non-final commits appear only in `commits`, and those stack members
-- have no row in default.merges at all.
--
-- Reverts are read from the same expanded `commits` array, and a ghstack stack is reverted the
-- same way it lands -- one push, one head_commit, the rest of the stack in the array. So this
-- query counts strictly more reverts than clickhouse_queries/reverts and
-- clickhouse_queries/num_reverts, which read head_commit only. The two populations are meant to
-- differ and this is the complete one; a stack member reverted alongside its siblings is
-- invisible to a head_commit-only scan.
--
-- A revert commit is itself the merge of the revert PR, so merge_commits does not exclude revert
-- titles: excluding them leaves a revert PR with no merge row at all, and a revert PR that is
-- later re-reverted then has no merged_at for its own verdict to be scored against. The nested
-- title of the commit being reverted sits inside quotes, so the trailing-'(#N)' match only ever
-- resolves the outer PR.
--
-- Do not simplify this to the ARRAY JOIN clause: under sqlfluff 3.3.0's clickhouse dialect a
-- following WHERE/GROUP BY/LIMIT is swallowed as its alias, costing this file all lint coverage.
--
-- ghfirst reverts are excluded from every count except ghfirst_reverts. A ghfirst revert is
-- forced by the internal-first landing path rather than by anything a reviewer could see in the
-- diff, so scoring one against a GreenLight verdict measures the landing path.
--
-- They are excluded from the arithmetic but still returned, for the same reason pr_number = 0
-- rows are: every count here rides on a row, so filtering a class of revert away takes its own
-- tally with it. A window whose reverts are all ghfirst would come back empty and report no
-- reverts at all, when in fact every one was excluded -- and with roughly half of all reverts
-- ghfirst, such a window is ordinary. The caller lists the excluded rows marked by their code
-- rather than dropping them; they are the examples a reader needs to check the exclusion against.
--
-- revert_classification = 'ghfirst', pr_number > 0 and pr_number = 0 partition the result
-- exactly: attributable_reverts + unattributable_reverts + ghfirst_reverts is the returned row
-- count. ghfirst wins over both, so a revert that is ghfirst AND unresolvable to a PR is counted
-- once, under ghfirst_reverts alone.
--
-- revert_classification and revert_message are the -c and -m arguments of the @pytorchbot revert
-- command that triggered the revert. The code is chosen from a fixed set and names which path
-- forced the revert; the message is the only place the cause is written; answerability to
-- GreenLight follows from the two together, not from either alone.
--
-- The command is found by the permalink mergebot writes into the revert commit message, not by
-- taking the newest revert comment on the reverted PR -- the reading in
-- clickhouse_queries/num_reverts, which has only the PR to key on. That reading is wrong both
-- ways here: a ghstack stack is reverted by one command on one member, leaving siblings with no
-- comment of their own, and a PR reverted twice carries two comments whose classifications
-- differ, of which the newest did not trigger the earlier revert. Siblings therefore carry the
-- parent's code and message, so identical text across one stack's rows is correct.
--
-- Both flags accept a space or an '=' before their value, in either order, and the message is
-- quoted with ', ", or a smart pair, so the message pattern carries one alternative per quote
-- style -- RE2 has no backreference to match the closing quote to the opening one. Each quoted
-- alternative admits a backslash-escaped quote inside the string rather than ending at it. A
-- fourth alternative takes an unquoted message to end of line; only that one has a trailing
-- -c clause stripped afterwards, because a quoted message may legitimately end in one.
--
-- The classification is read from the body with the message clause cut out, starting at the
-- command, and only a member of pytorchbot's own set is accepted. extract returns the leftmost
-- match, so without all three of those a -c written inside the message -- or in prose above the
-- command -- outranks the real flag. That is a reviewer-supplied string deciding whether a
-- revert counts against GreenLight, on the one field that removes a revert from the numerator.
-- The set has to be extended here if pytorchbot gains a classification; an unrecognised code
-- reads as '', which keeps the revert in the rate rather than silently dropping it.
--
-- A located command whose message will not parse is distinguishable from no command at all:
-- mergebot rejects a revert command that omits -c, so revert_classification is non-empty
-- whenever a command was found, and a non-empty code beside an empty message is the unparseable
-- case. Both empty means nothing was found.
--
-- Both columns are '' when the lookup does not resolve, and such a revert counts as NOT ghfirst:
-- internal 'Back out' commits carry no pytorchbot comment, and treating every revert the lookup
-- cannot explain as excluded would shrink the population silently. A missing permalink and a
-- resolved comment with no -c both land on '', but mergebot rejects a command omitting -c, so ''
-- means no command was found. A sentinel word here would be read as data.
--
-- revert_message has its whitespace collapsed to single spaces for a grid cell, and is capped at
-- 500 characters with an ellipsis, bounding an unauthenticated endpoint's payload.
--
-- default.issue_comment is a ReplacingMergeTree keyed on (issue_url, dynamoKey), and an edited
-- comment leaves more than one row behind. argMax on updated_at picks the surviving version, as
-- FINAL would, without paying FINAL's whole-table merge -- which on this table costs seconds and
-- a gigabyte, against a handful of revert comments per window.
--
-- misc.greenlight_pr_state keys on the PR head SHA, which is never a SHA that reaches main
-- (mergebot rebases), so a verdict can only be tied to a merge temporally, not by SHA.
--
-- A reverted PR usually re-lands, so the merge must be the last one strictly BEFORE the revert;
-- the newest merge overall is typically the re-land that happened afterwards.
--
-- merged_version_approved answers whether the verdict on the row was issued against the commit
-- that actually merged, which the temporal join alone cannot tell. Two independent sources
-- recover the merged head SHA, and mergebot's own record wins wherever both resolve.
--
-- default.merges.last_commit_sha is that record and needs no timing assumption, but it is keyed
-- on both PR number and merge commit SHA: a ghstack stack writes the same merge_commit_sha
-- against every member of the stack while each member keeps its own last_commit_sha, so matching
-- on the commit alone attaches a sibling's head. Failed and dry-run attempts are excluded because
-- they record the head that was attempted, not one that landed, and stack members that never
-- carried the merge command have no row at all.
--
-- The fallback is the head ref recorded on the PR: its pushes reach default.push, so the last one
-- before the merge is the version that merged. It applies only when the head branch lives in this
-- repo -- a fork branch never appears in default.push, and its name can collide with an unrelated
-- in-repo branch, which resolves to a stale SHA that looks legitimate.
--
-- 'unknown' means neither source resolved, or the row carries no LAND to check.
--
-- verdict_at, merged_at and reverted_at are NULL, not the epoch, where there is no verdict, no
-- merge and no revert to point at. maxIf over a LEFT JOIN miss returns 1970 rather than nothing,
-- and 1970 satisfies the <= merged_at test, so the epoch would otherwise reach the projection
-- looking like a timestamp; reverted_at picks it up from window_anchor on a quiet window. Only
-- the projection is masked: every CTE compares the raw values, where 1970 sorts correctly as
-- before-everything and merged_version_approved and the branch-head fallback depend on that.
--
WITH
(
    SELECT if(min(version) > toDateTime64(0, 3), min(version), now64(3))
    FROM misc.greenlight_pr_state
    WHERE repo = {repo: String}
) AS ledger_start,
greatest({startTime: DateTime64(3)}, ledger_start) AS window_start,
least({stopTime: DateTime64(3)}, now64(3)) AS window_end,
coalesce((
    SELECT uniqExactIf(pr_number, status != 'REVERTED')
    FROM misc.greenlight_pr_state
    WHERE
        repo = {repo: String}
        AND version >= window_start
        AND version < window_end
), 0) AS evaluated_prs_total,

revert_commits AS (
    SELECT DISTINCT
        sha AS revert_sha,
        committed_at AS reverted_at,
        toInt64OrZero(
            extract(
                message, 'Reverted https://github\\.com/[^/]+/[^/]+/pull/(\\d+)'
            )
        ) AS pr_number,
        extract(
            message, 'on behalf of https://github\\.com/([A-Za-z0-9._-]+)'
        ) AS reverter,
        toInt64OrZero(
            extract(
                message,
                '\\(\\[comment\\]\\([^)]*#issuecomment-(\\d+)\\)\\)'
            )
        ) AS trigger_comment_id
    FROM (
        SELECT
            tupleElement(c, 1) AS sha,
            tupleElement(c, 2) AS message,
            toDateTime64(tupleElement(c, 3), 3) AS committed_at
        FROM (
            SELECT
                arrayJoin(
                    arrayZip(
                        commits.id, commits.message, commits.timestamp
                    )
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
        AND (message LIKE 'Revert %' OR message LIKE 'Back out%')
),

revert_comments AS (
    SELECT
        id AS comment_id,
        argMax(body, updated_at) AS command_body
    FROM default.issue_comment
    WHERE
        match(body, '@pytorch(merge|)bot revert')
        AND created_at >= window_start - toIntervalDay(7)
        AND created_at < window_end + toIntervalDay(1)
    GROUP BY id
),

revert_commands AS (
    SELECT
        comment_id,
        replaceRegexpOne(
            command_body,
            '(?s)(?:-m|--message)[\s =]+(?:"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|“[^”]*”)',
            ' '
        ) AS body_outside_message,
        extract(
            body_outside_message,
            '(?s)@pytorch(?:merge|)bot\s+revert.*?(?:-c|--classification)[\s =]+["\']?'
            || '(nosignal|ignoredsignal|landrace|weird|ghfirst|autorevert)'
        ) AS revert_classification,
        extractGroups(
            command_body,
            '(?s)(?:-m|--message)[\s =]+(?:"((?:[^"\\\\]|\\\\.)*)"'
            || '|\'((?:[^\'\\\\]|\\\\.)*)\'|“([^”]*)”|([^\s"\'“][^\n]*))'
        ) AS message_parts,
        trimBoth(replaceRegexpAll(
            if(
                length(message_parts) = 4 AND message_parts[4] != '',
                replaceRegexpOne(
                    message_parts[4],
                    '(?s)\s+(?:-c|--classification)[\s =]+\S+\s*$',
                    ''
                ),
                arrayFirst(x -> x != '', arraySlice(message_parts, 1, 3))
            ),
            '\s+',
            ' '
        )) AS message_text,
        if(
            lengthUTF8(message_text) > 500,
            concat(substringUTF8(message_text, 1, 497), '...'),
            message_text
        ) AS revert_message
    FROM revert_comments
),

merge_commits AS (
    SELECT DISTINCT
        sha AS merged_sha,
        committed_at AS merged_at,
        splitByChar('\n', message)[1] AS commit_title,
        toInt64OrZero(
            extract(splitByChar('\n', message)[1], '\\(#(\\d+)\\)\\s*$')
        ) AS pr_number
    FROM (
        SELECT
            tupleElement(c, 1) AS sha,
            tupleElement(c, 2) AS message,
            toDateTime64(tupleElement(c, 3), 3) AS committed_at
        FROM (
            SELECT
                arrayJoin(
                    arrayZip(
                        commits.id, commits.message, commits.timestamp
                    )
                ) AS c
            FROM default.push
            WHERE
                push.ref IN ('refs/heads/main', 'refs/heads/master')
                AND push.repository.full_name = {repo: String}
                AND push.head_commit.timestamp
                >= window_start - toIntervalDay(60)
                AND push.head_commit.timestamp < window_end + toIntervalDay(1)
        )
    )
    WHERE match(splitByChar('\n', message)[1], '\\(#\\d+\\)\\s*$')
),

reverted_prs AS (
    SELECT
        r.pr_number AS pr_number,
        r.revert_sha AS revert_sha,
        r.reverted_at AS reverted_at,
        any(r.reverter) AS reverter,
        any(r.trigger_comment_id) AS trigger_comment_id,
        argMaxIf(
            m.merged_sha, m.merged_at, m.merged_at < r.reverted_at
        ) AS merged_sha,
        argMaxIf(
            m.commit_title, m.merged_at, m.merged_at < r.reverted_at
        ) AS commit_title,
        maxIf(m.merged_at, m.merged_at < r.reverted_at) AS merged_at
    FROM revert_commits AS r
    LEFT JOIN merge_commits AS m ON r.pr_number = m.pr_number
    GROUP BY r.pr_number, r.revert_sha, r.reverted_at
),

terminal_verdicts AS (
    SELECT
        pr_number,
        status,
        head_sha,
        version
    FROM misc.greenlight_pr_state
    WHERE repo = {repo: String} AND status IN ('LAND', 'NO_LAND')
),

scored AS (
    SELECT
        p.pr_number AS pr_number,
        p.revert_sha AS revert_sha,
        p.reverted_at AS reverted_at,
        any(p.reverter) AS reverter,
        any(p.merged_sha) AS merged_sha,
        any(p.commit_title) AS commit_title,
        any(p.merged_at) AS merged_at,
        any(p.trigger_comment_id) AS trigger_comment_id,
        argMaxIf(v.status, v.version, v.version <= p.merged_at) AS verdict,
        argMaxIf(
            v.head_sha, v.version, v.version <= p.merged_at
        ) AS verdict_head_sha,
        maxIf(v.version, v.version <= p.merged_at) AS verdict_at
    FROM reverted_prs AS p
    LEFT JOIN terminal_verdicts AS v ON p.pr_number = v.pr_number
    GROUP BY p.pr_number, p.revert_sha, p.reverted_at
),

classified AS (
    SELECT
        s.*,
        rc.revert_classification AS revert_classification,
        rc.revert_message AS revert_message,
        rc.revert_classification != 'ghfirst' AS counts_toward_rate
    FROM scored AS s
    LEFT JOIN revert_commands AS rc
        ON s.trigger_comment_id = rc.comment_id
),

counted AS (
    SELECT
        *,
        sum(NOT counts_toward_rate) OVER () AS ghfirst_reverts,
        sum(pr_number > 0) OVER () AS resolvable_reverts,
        sum(
            counts_toward_rate AND pr_number > 0
        ) OVER () AS attributable_reverts,
        sum(
            counts_toward_rate AND pr_number > 0 AND verdict != ''
        ) OVER () AS evaluated_reverts,
        sum(
            counts_toward_rate AND pr_number > 0 AND verdict = 'LAND'
        ) OVER () AS land_approved_reverts,
        sum(
            NOT counts_toward_rate AND pr_number > 0 AND verdict = 'LAND'
        ) OVER () AS land_approved_ghfirst_reverts,
        sum(
            counts_toward_rate AND pr_number = 0
        ) OVER () AS unattributable_reverts
    FROM classified
),

pr_meta AS (
    SELECT
        number,
        title,
        pull_request.user.login AS author,
        if(
            head.repo.full_name = {repo: String},
            concat('refs/heads/', head.ref),
            ''
        ) AS head_ref
    FROM default.pull_request
    WHERE
        startsWith(dynamoKey, concat({repo: String}, '/'))
        AND number IN (SELECT pr_number FROM revert_commits)
    ORDER BY number ASC, updated_at DESC
    LIMIT 1 BY number
),

branch_heads AS (
    SELECT
        push.ref AS head_ref,
        head_commit.id AS head_sha,
        head_commit.timestamp AS pushed_at
    FROM default.push
    WHERE
        push.repository.full_name = {repo: String}
        AND push.head_commit.timestamp >= window_start - toIntervalDay(60)
        AND push.head_commit.timestamp < window_end + toIntervalDay(1)
        AND push.ref NOT IN ('refs/heads/main', 'refs/heads/master')
        AND push.head_commit.id != ''
),

merge_heads AS (
    SELECT
        pr_num,
        merge_commit_sha,
        argMax(last_commit_sha, comment_id) AS head_sha
    FROM default.merges
    WHERE
        owner = splitByChar('/', {repo: String})[1]
        AND project = splitByChar('/', {repo: String})[2]
        AND NOT is_failed
        AND NOT dry_run
        AND merge_commit_sha != ''
    GROUP BY pr_num, merge_commit_sha
),

resolved AS (
    SELECT
        c.pr_number AS pr_number,
        c.revert_sha AS revert_sha,
        c.reverted_at AS reverted_at,
        any(if(pm.title = '', c.commit_title, pm.title)) AS title,
        any(pm.author) AS author,
        any(c.merged_sha) AS merged_sha,
        any(c.merged_at) AS merged_at,
        any(c.verdict) AS verdict,
        any(c.verdict_head_sha) AS verdict_head_sha,
        any(c.verdict_at) AS verdict_at,
        any(c.reverter) AS reverter,
        any(c.revert_classification) AS revert_classification,
        any(c.revert_message) AS revert_message,
        any(c.resolvable_reverts) AS resolvable_reverts,
        any(c.attributable_reverts) AS attributable_reverts,
        any(c.evaluated_reverts) AS evaluated_reverts,
        any(c.land_approved_reverts) AS land_approved_reverts,
        any(c.land_approved_ghfirst_reverts) AS land_approved_ghfirst_reverts,
        any(c.unattributable_reverts) AS unattributable_reverts,
        any(c.ghfirst_reverts) AS ghfirst_reverts,
        coalesce(
            nullIf(any(mh.head_sha), ''),
            argMaxIf(b.head_sha, b.pushed_at, b.pushed_at < c.merged_at)
        ) AS merged_head
    FROM counted AS c
    LEFT JOIN pr_meta AS pm ON c.pr_number = pm.number
    LEFT JOIN branch_heads AS b ON pm.head_ref = b.head_ref
    LEFT JOIN merge_heads AS mh
        ON c.pr_number = mh.pr_num AND c.merged_sha = mh.merge_commit_sha
    GROUP BY c.pr_number, c.revert_sha, c.reverted_at
),

anchored AS (
    SELECT
        *,
        1 AS window_key
    FROM resolved
)

SELECT
    r.pr_number AS pr_number,
    r.title AS title,
    r.author AS author,
    r.merged_sha AS merged_sha,
    if(r.merged_at = toDateTime64(0, 3), NULL, r.merged_at) AS merged_at,
    r.verdict AS verdict,
    if(r.verdict = '', NULL, r.verdict_at) AS verdict_at,
    if(r.reverted_at = toDateTime64(0, 3), NULL, r.reverted_at) AS reverted_at,
    r.revert_sha AS revert_sha,
    r.reverter AS reverter,
    r.revert_classification AS revert_classification,
    r.revert_message AS revert_message,
    multiIf(
        r.verdict != 'LAND', 'unknown',
        r.merged_head = '', 'unknown',
        r.merged_head = r.verdict_head_sha, 'yes',
        'no'
    ) AS merged_version_approved,
    r.resolvable_reverts AS resolvable_reverts,
    r.attributable_reverts AS attributable_reverts,
    r.evaluated_reverts AS evaluated_reverts,
    r.land_approved_reverts AS land_approved_reverts,
    r.land_approved_ghfirst_reverts AS land_approved_ghfirst_reverts,
    r.unattributable_reverts AS unattributable_reverts,
    r.ghfirst_reverts AS ghfirst_reverts,
    evaluated_prs_total
FROM (SELECT 1 AS window_key) AS window_anchor
LEFT JOIN anchored AS r ON window_anchor.window_key = r.window_key
ORDER BY reverted_at DESC, pr_number ASC
LIMIT 5000
