-- GreenLight's verdict for the revision that produced each trunk commit.
--
-- Keyed by trunk commit, not by PR: a PR can land, be reverted, be fixed and
-- land again, GreenLight reviews the fixed head too, and each landing has to
-- carry the verdict issued against it rather than the newest one.
--
-- Terminal verdicts only. A revert emits a REVERTED row against the same
-- head_sha with a higher run_id, which would otherwise erase the approval from
-- a commit that was genuinely approved when it landed.
--
-- Shadow rows carry no authority, and the exclusion sits in WHERE so they are
-- gone before LIMIT 1 BY picks a winner: filtering after the collapse would
-- hide the genuine verdict a later shadow row outranked.
--
-- GreenLight records the PR head it reviewed, and mergebot rebases, so a trunk
-- commit never matches that head directly and the head has to be recovered.
-- Two sources recover it, and mergebot's own record wins wherever both resolve.
--
-- default.merges.last_commit_sha is that record and needs no timing assumption,
-- but mergebot writes one row per merge command: a ghstack stack lands as a
-- single push, and the members that did not carry the command have no row at
-- all. Those members, not re-landings, are the bulk of what merges alone misses.
--
-- The fallback is the head ref recorded on the PR: its pushes reach
-- default.push, so the last head recorded against that ref before this commit
-- is the revision that landed as it. Both sides of that comparison are
-- committer dates -- head_commit.timestamp for the branch head, the trunk
-- commit's own date for the landing -- rather than push-event times, so they
-- are on one clock. Reading each commit's own date rather than the PR's is
-- what keeps the two landings of a re-landed PR apart.
--
-- The fallback holds only where the head branch lives in this repo -- a fork
-- branch never reaches default.push, and its name can collide with an unrelated
-- in-repo branch, which resolves to a stale SHA that looks legitimate.
-- pull_request.head.sha cannot stand in for it either: default.pull_request
-- collapses on (number, dynamoKey) with no version column, so the surviving row
-- carries whichever head the PR has now, which on a reverted and re-pushed PR
-- postdates every commit being drawn.
--
-- Neither source resolving leaves the head empty, and the join rejects that
-- rather than matching a verdict row that happens to carry none.
--
-- The caller passes the commits it is drawing as three positionally aligned
-- arrays. Every table but default.push is entered on its own sorting-key
-- prefix -- pr_number for the ledger, number for the PR, pr_num for the merge
-- record -- which is why the PR numbers are a parameter rather than a join key
-- derived inside the query.
WITH reviewed AS
(
    SELECT pr_number, head_sha, status
    FROM misc.greenlight_pr_state
    WHERE repo = {repo: String}
      AND pr_number IN {prNumbers: Array(Int64)}
      AND status IN ('LAND', 'NO_LAND')
      AND shadow = false
    ORDER BY pr_number, head_sha, run_id DESC, version DESC
    LIMIT 1 BY pr_number, head_sha
),
-- OrNull, not the throwing form: the API route hands caller-supplied parameters
-- straight to ClickHouse, and parseDateTime64BestEffort('') raises rather than
-- returning anything, which would take the whole panel down over one bad entry.
-- A null date compares null against every push, so that commit simply resolves
-- through merges or not at all.
trunk_commits AS
(
    SELECT
        commit.1 AS sha,
        commit.2 AS pr_number,
        parseDateTime64BestEffortOrNull(commit.3, 3) AS committed_at
    FROM
    (
        SELECT
            arrayJoin(
                arrayZip(
                    {shas: Array(String)},
                    {prNumbers: Array(Int64)},
                    {committedAts: Array(String)}
                )
            ) AS commit
    )
),
pr_meta AS
(
    SELECT
        number,
        if(
            head.repo.full_name = {repo: String},
            concat('refs/heads/', head.ref),
            ''
        ) AS head_ref
    FROM default.pull_request
    WHERE
        startsWith(dynamoKey, concat({repo: String}, '/'))
        AND number IN {prNumbers: Array(Int64)}
    ORDER BY number ASC, updated_at DESC
    LIMIT 1 BY number
),
-- A failed merge records an empty merge_commit_sha, and one merge command can
-- record several rows; the guard and the grouping keep the join from fanning
-- out.
merge_heads AS
(
    SELECT
        pr_num,
        merge_commit_sha,
        argMax(last_commit_sha, comment_id) AS head_sha
    FROM default.merges
    WHERE
        owner = {owner: String}
        AND project = {project: String}
        AND pr_num IN {prNumbers: Array(Int64)}
        AND dry_run = false
        AND merge_commit_sha != ''
    GROUP BY pr_num, merge_commit_sha
),
-- Only the commits merges did not account for need a branch head, so only their
-- refs are carried into the read below. That bounds what comes back out of it,
-- not what it reads -- default.push has no index on ref.
--
-- A join miss reads as '' under join_use_nulls = 0 and as NULL under 1, and
-- ifNull collapses both. Testing either one alone leaves this CTE empty under
-- the other setting, which turns the whole branch fallback off and gives back
-- the merges-only results with nothing failing to say so.
fallback_refs AS
(
    SELECT DISTINCT pm.head_ref AS head_ref
    FROM trunk_commits AS c
    INNER JOIN pr_meta AS pm ON c.pr_number = pm.number
    LEFT JOIN merge_heads AS mh
        ON c.pr_number = mh.pr_num AND c.sha = mh.merge_commit_sha
    WHERE pm.head_ref != '' AND ifNull(mh.merge_commit_sha, '') = ''
),
-- This read is the whole cost of the query; every other table above is entered
-- on a sorting-key prefix and touches a handful of granules. Two things about
-- default.push shape it, and both are easy to undo by accident.
--
-- The window bounds are spelled tupleElement(head_commit, 'timestamp') because
-- that is the sorting key expression verbatim. The equivalent subcolumn form,
-- head_commit.timestamp, is not recognised by the key condition -- it resolves
-- to true and reads all ~3600 granules however narrow the window is. Written
-- this way a 30-day window reads ~140. That holds under both analysers.
--
-- Naming the tuple makes ClickHouse materialise all of it, commit messages
-- included, so the ref filter sits in PREWHERE: ref is the cheap column, and
-- restricting on it first leaves the tuple to be built only for the rows that
-- survive. ref itself prunes nothing -- default.push carries no index on it.
--
-- 30 days rather than 60 halves the rows in range and cost nothing measurable:
-- the same marks over a week of trunk, with no commit resolving to a different
-- head. Narrowing can only lose a head, never pick a wrong one anyway -- inside
-- any window holding a push at all, the last push in the window is the last
-- push before the commit.
branch_heads AS
(
    SELECT
        push.ref AS head_ref,
        head_commit.id AS head_sha,
        head_commit.timestamp AS pushed_at
    FROM default.push
    PREWHERE push.ref IN (SELECT head_ref FROM fallback_refs)
    WHERE
        push.repository.full_name = {repo: String}
        AND tupleElement(head_commit, 'timestamp')
        >= (SELECT min(committed_at) FROM trunk_commits) - toIntervalDay(30)
        AND tupleElement(head_commit, 'timestamp')
        < (SELECT max(committed_at) FROM trunk_commits)
        AND push.head_commit.id != ''
),
landed AS
(
    SELECT
        c.sha AS sha,
        c.pr_number AS pr_number,
        coalesce(
            nullIf(any(mh.head_sha), ''),
            argMaxIf(b.head_sha, b.pushed_at, b.pushed_at < c.committed_at)
        ) AS head_sha
    FROM trunk_commits AS c
    LEFT JOIN pr_meta AS pm ON c.pr_number = pm.number
    LEFT JOIN branch_heads AS b ON pm.head_ref = b.head_ref
    LEFT JOIN merge_heads AS mh
        ON c.pr_number = mh.pr_num AND c.sha = mh.merge_commit_sha
    GROUP BY c.sha, c.pr_number
)
SELECT
    landed.sha AS sha,
    reviewed.status AS status
FROM landed
INNER JOIN reviewed
    ON reviewed.pr_number = landed.pr_number
   AND reviewed.head_sha = landed.head_sha
WHERE landed.head_sha != ''
