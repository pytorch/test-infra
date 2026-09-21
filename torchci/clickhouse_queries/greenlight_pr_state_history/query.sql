-- Latest greenlight state per reviewed commit, for a single PR.
--
-- Sibling of greenlight_pr_states, which collapses to one row per PR for a whole
-- Dr.CI sweep. This one collapses per head_sha instead, for the commit-scoped
-- HUD pages. run_id ahead of version is what makes the pick race-proof: a
-- superseded slower dispatch that finishes later still loses.
--
-- merge_commit_sha is the trunk commit that reviewed head landed as, or '' if it
-- never landed. Mergebot rebases, so a trunk commit never carries the sha that
-- was reviewed; this is what lets a commit page match its verdict without
-- falling back to "some other verdict for the same PR".
--
-- Shadow rows carry no authority, and the exclusion sits in WHERE so they are
-- gone before LIMIT 1 BY picks a winner: filtering after the collapse would
-- hide the genuine verdict a later shadow row outranked.
--
-- default.merges is not enough to fill merge_commit_sha on its own. Mergebot
-- writes one row per merge command, and a ghstack stack lands as a single push,
-- so every member below the one that carried the command has no row at all and
-- its commit page finds nothing to match. The caller therefore passes the commit
-- it is displaying, and the head that landed as it is recovered from the pushes
-- to the PR's own head ref: the last one before that commit's committer date.
--
-- That runs in the one direction the push data supports. It answers "which head
-- became this commit", never "which commit did this head become", so it is
-- resolved once for the viewed commit and used to tag the row whose head_sha it
-- names. Rows mergebot already accounted for keep their own value -- the
-- coalesce below prefers it, and it needs no timing assumption.
--
-- The recovery holds only where the head branch lives in this repo: a fork
-- branch never reaches default.push, and its name can collide with an unrelated
-- in-repo branch, which resolves to a stale SHA that looks legitimate.
-- pull_request.head.sha cannot stand in for it either, since default.pull_request
-- collapses on (number, dynamoKey) with no version column and the surviving row
-- carries whichever head the PR has now.
--
-- Those two fail closed -- nothing matches, and the page shows no panel. The
-- limitation that fires in practice fails open instead: a head GreenLight did
-- review can be absent from default.push altogether, and the last push before
-- the commit is then an earlier revision carrying a verdict of its own. Where
-- mergebot recorded the landing the guard below refuses the tag; that is the
-- observed shape, 3 of 162 covered landings over 45 days, and it was producing
-- two rows for one trunk commit. On a stack member mergebot never recorded, the
-- same gap instead leaves the panel naming a revision the commit was not cut
-- from, which no guard here reaches. Refusing on the suspicion -- whenever
-- GreenLight saw a head later than the last push -- was measured and refuses
-- 161 of 162, so it is not a trade worth making.
--
-- Both parameters are empty for the PR page, which shares this read with its
-- commit picker and selects branch commits that match head_sha directly. A null
-- date leaves the window below unsatisfiable, so the push read selects no
-- granules, and it gates the PR lookup too so that costs nothing either.
WITH reviewed AS (
    SELECT
        pr_number,
        head_sha,
        status,
        reason,
        message,
        eval_job,
        run_id,
        version
    FROM misc.greenlight_pr_state
    WHERE
        repo = {repo: String}
        AND pr_number = {prNumber: Int64}
        AND shadow = false
    ORDER BY head_sha, run_id DESC, version DESC
    LIMIT 1 BY head_sha
),

-- A failed merge records an empty merge_commit_sha, and one merge can record
-- several rows; both guards keep the join from fanning out.
landed AS (
    SELECT
        last_commit_sha,
        merge_commit_sha
    FROM merges
    WHERE
        owner = {owner: String}
        AND project = {project: String}
        AND pr_num = {prNumber: Int64}
        AND dry_run = false
        AND merge_commit_sha != ''
    ORDER BY merge_commit_sha
    LIMIT 1 BY merge_commit_sha
),

-- OrNull, not the throwing form: the API route hands caller-supplied parameters
-- straight to ClickHouse, and parseDateTime64BestEffort('') raises rather than
-- returning anything, which would take the panel down over one bad value.
viewed AS (
    SELECT
        parseDateTime64BestEffortOrNull({committedAt: String}, 3)
            AS committed_at
),

-- Gated on the date as well as the PR, so the PR page's call reads nothing here
-- either. The point lookup is cheap in granules but default.pull_request is wide
-- enough that it still costs a couple of hundred milliseconds, every minute, on
-- a page that never uses the answer.
pr_head_ref AS (
    SELECT
        if(
            head.repo.full_name = {repo: String},
            concat('refs/heads/', head.ref),
            ''
        ) AS head_ref
    FROM default.pull_request
    WHERE
        startsWith(dynamoKey, concat({repo: String}, '/'))
        AND number = {prNumber: Int64}
        AND (SELECT isNotNull(committed_at) FROM viewed)
    ORDER BY updated_at DESC
    LIMIT 1
),

-- The upper bound is the strict comparison the recovery rests on: a push at or
-- after the viewed commit belongs to a later revision of the PR, and taking one
-- would put this commit's verdict on a revision it was not cut from.
--
-- Both bounds are spelled tupleElement(head_commit, 'timestamp') because that is
-- default.push's sorting key expression verbatim. The equivalent subcolumn form,
-- head_commit.timestamp, is not recognised by the key condition -- it resolves to
-- true and reads every granule in the table however narrow the window is.
-- Naming the tuple makes ClickHouse materialise all of it, commit messages
-- included, so the ref filter sits in PREWHERE, where the cheap column decides
-- which rows are worth building the tuple for. ref prunes nothing itself:
-- default.push carries no index on it.
--
-- A null date leaves both bounds unsatisfiable, which is how the PR page's empty
-- call reads no granules at all rather than scanning.
branch_heads AS (
    SELECT
        head_commit.id AS head_sha,
        head_commit.timestamp AS pushed_at
    FROM default.push
    PREWHERE
        push.ref IN (
            SELECT head_ref FROM pr_head_ref
            WHERE head_ref != ''
        )
    WHERE
        push.repository.full_name = {repo: String}
        AND tupleElement(head_commit, 'timestamp')
        >= (SELECT committed_at FROM viewed) - toIntervalDay(30)
        AND tupleElement(head_commit, 'timestamp')
        < (SELECT committed_at FROM viewed)
        AND push.head_commit.id != ''
),

viewed_head AS (
    SELECT argMax(head_sha, pushed_at) AS head_sha
    FROM branch_heads
)

SELECT
    reviewed.pr_number AS pr_number,
    reviewed.head_sha AS head_sha,
    -- Mergebot's record first, and only where it resolved: a join miss reads as
    -- '' under join_use_nulls = 0 and as NULL under 1, and nullIf plus coalesce
    -- take both to the recovered head. Testing one alone would either ignore
    -- mergebot or never fall through, depending on the setting.
    --
    -- The invariant the second condition enforces: where merges says this trunk
    -- commit came from head X, the recovery must not claim it for head Y. The
    -- coalesce alone cannot, being per row -- it keeps X's own value and then
    -- tags Y as well, and the caller's matcher takes whichever row it reaches
    -- first. Two rows carrying one trunk sha is worse than none, because the
    -- page then shows a verdict chosen by nothing.
    --
    -- The third guards the tag itself: argMax over no rows returns '', which
    -- would otherwise make the test `head_sha = ''` and rest on no ledger row
    -- ever carrying an empty head.
    coalesce(
        nullIf(landed.merge_commit_sha, ''),
        if(
            reviewed.head_sha = (SELECT head_sha FROM viewed_head)
            AND (
                SELECT count()
                FROM landed
                WHERE merge_commit_sha = {sha: String}
            ) = 0
            AND (SELECT head_sha FROM viewed_head) != '',
            {sha: String},
            ''
        )
    ) AS merge_commit_sha,
    reviewed.status AS status,
    reviewed.reason AS reason,
    reviewed.message AS message,
    reviewed.eval_job AS eval_job,
    reviewed.run_id AS run_id,
    reviewed.version AS version
FROM reviewed
LEFT JOIN landed ON landed.last_commit_sha = reviewed.head_sha
