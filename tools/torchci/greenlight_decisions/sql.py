"""The ClickHouse query behind the greenlight decision export, and the patterns it takes.

Five properties of the underlying tables shape ``SQL_DECISIONS`` and are easy to get wrong:

``default.pull_request`` is a ``SharedReplacingMergeTree`` keyed ``(number, dynamoKey)`` with no
version column, and its merges are asynchronous, so any number of snapshot rows per PR can be
live at once and no bound on that number is safe to assume. Every read of it here is deduped with
``argMax(col, updated_at)``. ``updated_at`` is a String, but the mirrored values are ISO-8601 Z
throughout, which makes lexicographic ordering chronological.

``default.pull_request_review`` records one row per webhook delivery, not per review, and a
``dismissed`` delivery repeats the review's *original* ``submitted_at``. Picking the latest row
per login therefore cannot see a dismissal -- it ties with the ``submitted`` row it revokes. Rows
are collapsed per ``review.id`` first so that a dismissal becomes that review's state, and only
then reduced to one review per login. Dismissal is applied *after* that reduction rather than
before, because GitHub leaves an author with no standing at all once their latest review is
dismissed instead of falling back to an earlier surviving one: PR 193118 carries two live
CHANGES_REQUESTED reviews behind a dismissed approval by the same author, and GitHub reports it
as having no opinionated review.

``misc.greenlight_pr_state`` is append-only history: ``emit_id`` ends its sort key, so no row ever
collapses and the authoritative row per PR is chosen at read time. ``last_attempt`` reproduces the
selection ``greenlight/src/greenlight/state.py`` makes; ``decision_row`` deliberately departs from
it, for the reason recorded at that CTE.

``misc.greenlight_pr_state.shadow`` marks a row whose evaluation carried no authority: greenlight
fingerprints, dispatches and records the PR as usual but posts no approving review, and both
Dr. CI and the land-time merge gate drop such rows. The export reports it per PR rather than per
verdict, because a PR greenlight never reached a verdict on still carries the flag and reading it
off the selected verdict row would report every one of those as authoritative. The aggregate is
folded into ``corpus`` rather than joined in from a CTE of its own to avoid a redundant join, not
to make the column total: a separate CTE over the same ``gl_rows`` would cover exactly the same
PRs. The cost is one error direction -- a PR whose author joins ``TRUSTED_AUTHORS`` mid-review
holds rows of both kinds and reads shadow, though the verdict that applies to it carried
authority.

That table is not a revert history and must not be read as one: its ``REVERTED`` rows exist
only for PRs that were still open when a scan listed them, so a PR reverted after it closed never
receives one. ``landed`` and ``reverted`` both come from the trailers mergebot writes on
``refs/heads/main``, which records every landing and every revert whatever state the PR ended in.

Those trailers are the primary landing signal, not a belt-and-braces fallback. Measured on
2026-09-03, 98 of the 153 corpus PRs are classified as landed by the trailer alone and only 5 by
GitHub's ``merged`` flag, which catches the merge-button landings that leave no trailer. If the
trailer format ever changes, almost every landed PR silently becomes ``closed-abandoned`` and the
resulting CSV looks entirely normal, so ``fetch_decisions`` refuses to return a result in which
the trailer matched nothing at all.
"""

# pytorch/pytorch-canary pushes 1,440 commits carrying pytorch/pytorch trailers, so both trailer
# checks pin the repository on the push rows and inside the pattern itself.
#
# torchci/clickhouse_queries/merge_retry_rate and pr_landing_time_avg answer a similar question
# from the 'Merged' label instead, so their counts drift from this tool's by construction. The
# trailer is the better signal here and should not be "fixed" toward theirs: across the corpus's
# closed PRs the two agree except where the trailer is right and the label is absent -- 193432 and
# 195741 carry mergedog/mergedX1 labels, which a name equality test on 'Merged' misses.
_LANDED_PATTERN = r"Pull Request resolved: https://github\.com/{repo}/pull/(\d+)"
_REVERT_PATTERN = r"Reverted https://github\.com/{repo}/pull/(\d+)"

# Not exported: a per-row health signal for the trailer scan that _coerce drops.
_TRAILER_HEALTH_FIELD = "landed_via_trailer"

# Joins every multi-valued cell in the export, not just the login lists this query produces.
# Owned here because this is where the joining happens; consumers that split or document such a
# cell import it rather than restating it.
MULTI_VALUE_SEPARATOR = ";"

SQL_DECISIONS = """
WITH
gl_rows AS (
    SELECT
        pr_number,
        status,
        reason,
        message,
        lower(head_sha) AS head_sha,
        run_id,
        version,
        shadow
    FROM misc.greenlight_pr_state
    WHERE repo = {repo:String}
      AND pr_number != {synthetic_pr:Int64}
      -- as_of arrives as text and is cast here rather than bound as a DateTime64, because
      -- clickhouse-connect drops the sub-second component when it formats a datetime parameter.
      -- version is millisecond precision and nearly every verdict lands on a nonzero millisecond,
      -- so a bound datetime silently floors the cutoff to the second and hides whole verdicts.
      AND version <= toDateTime64({as_of:String}, 3, 'UTC')
),
-- One PR's rows can disagree: the scan derives shadow from the PR's author (review.py) while the
-- verdict CLI takes the caller's --shadow flag, ORed with its own author lookup on a terminal
-- verdict (verdict.py). max() resolves that toward shadow -- the same attribution that
-- torchci/clickhouse_queries/greenlight_quality_coverage and greenlight_quality_reverts make per
-- pr_number, so this export and those tiles bucket a PR alike.
corpus AS (
    SELECT pr_number, max(shadow) AS is_shadow FROM gl_rows GROUP BY pr_number
),
pr_meta AS (
    SELECT
        number AS pr_number,
        argMax(state, updated_at) AS state,
        argMax(merged, updated_at) AS merged,
        argMax(lower(head.sha), updated_at) AS final_head_sha,
        argMax(lower(base.sha), updated_at) AS base_sha,
        argMax(base.ref, updated_at) AS base_ref,
        argMax(additions, updated_at) AS additions,
        argMax(deletions, updated_at) AS deletions,
        argMax(changed_files, updated_at) AS changed_files
    FROM default.pull_request
    WHERE startsWith(dynamoKey, concat({repo:String}, '/'))
      AND number IN (SELECT pr_number FROM corpus)
    GROUP BY number
),
main_commit_messages AS (
    SELECT arrayJoin(commits.message) AS msg
    FROM default.push
    WHERE repository.full_name = {repo:String}
      AND ref = {main_ref:String}
),
landed_prs AS (
    SELECT DISTINCT pr_number
    FROM (
        SELECT toInt64OrZero(extract(msg, {landed_pattern:String})) AS pr_number
        FROM main_commit_messages
    )
    WHERE pr_number > 0
),
reverted_prs AS (
    SELECT DISTINCT pr_number
    FROM (
        SELECT toInt64OrZero(extract(msg, {revert_pattern:String})) AS pr_number
        FROM main_commit_messages
    )
    WHERE pr_number > 0
),
terminal_rows AS (
    SELECT
        g.pr_number AS pr_number,
        g.status AS status,
        g.reason AS reason,
        g.message AS message,
        g.head_sha AS head_sha,
        g.run_id AS run_id,
        g.version AS version,
        g.head_sha = p.final_head_sha AS matches_head
    FROM gl_rows AS g
    LEFT JOIN pr_meta AS p ON g.pr_number = p.pr_number
    WHERE g.status IN ('LAND', 'NO_LAND')
),
-- matches_head outranks recency deliberately, and this is the file's central business rule. The
-- question the export answers is what greenlight said about the code that actually shipped, so a
-- verdict passing judgement on the PR's current head beats a newer verdict passing judgement on
-- a head that no longer exists. Only when no verdict names the current head does this fall back
-- to run_id DESC, version DESC -- which is then exactly state.py's selection, run_id ahead of
-- version so a superseded slow dispatch cannot win on a later version alone.
decision_row AS (
    SELECT pr_number, status, reason, message, head_sha, run_id, version
    FROM terminal_rows
    ORDER BY pr_number, matches_head DESC, run_id DESC, version DESC
    LIMIT 1 BY pr_number
),
terminal_counts AS (
    SELECT
        pr_number,
        count() AS n_terminal_decisions,
        uniqExact(status) > 1 AS verdict_flipped
    FROM terminal_rows
    GROUP BY pr_number
),
last_attempt AS (
    SELECT pr_number, status
    FROM gl_rows
    WHERE status != 'REVERTED'
    ORDER BY pr_number, run_id DESC, version DESC
    LIMIT 1 BY pr_number
),
-- Computed from the raw review records because neither GitHub GraphQL field means what its
-- name suggests: latestOpinionatedReviews silently drops approvals from authors without push
-- access (it hides wdvr's real approval on PR 185173), and latestReviews lets a later COMMENTED
-- review mask a standing approval (PR 194841 and four others in this corpus). An author's
-- opinion is their latest non-COMMENTED review, and a dismissal leaves them with none.
resolved_reviews AS (
    SELECT
        pull_request.number AS pr_number,
        review.id AS review_id,
        any(review.user.login) AS login,
        max(review.submitted_at) AS submitted_at,
        -- The countIf is the entire dismissal mechanism; do not fold it away. Every delivery for
        -- one review.id repeats that review's state, so the surviving branch only has to pick any
        -- non-dismissed row -- it does no recency selection and must not be trusted to.
        if(
            countIf(action = 'dismissed' OR lower(review.state) = 'dismissed') > 0,
            'dismissed',
            anyIf(lower(review.state), action != 'dismissed')
        ) AS state
    FROM default.pull_request_review
    WHERE repository.full_name = {repo:String}
      AND review.user.type != 'Bot'
      AND pull_request.number IN (SELECT pr_number FROM corpus)
    GROUP BY pr_number, review_id
),
latest_review_per_login AS (
    SELECT pr_number, login, state
    FROM resolved_reviews
    WHERE state != 'commented'
    ORDER BY pr_number, login, submitted_at DESC, review_id DESC
    LIMIT 1 BY pr_number, login
),
human_reviews AS (
    SELECT
        pr_number,
        countIf(state = 'approved') AS human_approvals,
        countIf(state = 'changes_requested') AS human_changes_requested,
        arrayStringConcat(
            arraySort(groupArrayIf(login, state = 'approved')), {multi_value_separator:String}
        ) AS human_approvers,
        arrayStringConcat(
            arraySort(groupArrayIf(login, state = 'changes_requested')), {multi_value_separator:String}
        ) AS human_change_requesters
    FROM latest_review_per_login
    GROUP BY pr_number
)
SELECT
    {repo:String} AS repo,
    c.pr_number AS pr_number,
    concat('https://github.com/', {repo:String}, '/pull/', toString(c.pr_number)) AS pr_url,
    -- Reports a PR closed as a duplicate as closed-abandoned, with no separate value for it:
    -- closing as a duplicate is an issues-only action, GitHub's pull request object carries no
    -- state_reason at all, and default.issues holds no row for any PR in the corpus.
    -- This is the PR's state, NOT a did-this-ship predicate -- pytorch reopens a PR when it is
    -- reverted, so a landed PR can read 'open' here. Use the landed column for that question.
    multiIf(
        p.state = 'open', 'open',
        landed, 'closed-merged',
        'closed-abandoned'
    ) AS pr_status,
    -- merged covers the merge button, which is how every release-branch PR lands and is the only
    -- landing that leaves no trailer on main; the trailer covers normal and ghstack landings,
    -- where mergebot rebases and pushes rather than pressing merge. Neither branch alone is
    -- complete, and reading pr_status = 'closed-merged' as this predicate is wrong in both
    -- directions.
    p.merged OR landed_via_trailer AS landed,
    p.base_ref AS base_ref,
    d.status AS decision,
    d.reason AS decision_reason,
    d.message AS decision_message,
    d.head_sha AS decision_head_sha,
    if(d.status = '', NULL, d.run_id) AS decision_run_id,
    if(d.status = '', NULL, d.version) AS decision_version,
    p.final_head_sha AS final_head_sha,
    p.base_sha AS base_sha,
    -- The empty test for never-reviewed is the LEFT JOIN miss, so a status greenlight adds later
    -- falls to 'unknown' rather than quietly reporting as never having been looked at.
    multiIf(
        d.status != '', 'decided',
        a.status = '', 'never-reviewed',
        a.status IN ('AI_REVIEW_STARTED', 'AI_REVIEW_DISPATCHED'), 'in-flight',
        a.status IN ('CANCELLED', 'FAILED'), 'failed',
        'unknown'
    ) AS lifecycle_status,
    c.pr_number IN (SELECT pr_number FROM reverted_prs) AS reverted,
    c.is_shadow AS is_shadow,
    tc.n_terminal_decisions AS n_terminal_decisions,
    tc.verdict_flipped AS verdict_flipped,
    r.human_approvals AS human_approvals,
    r.human_approvers AS human_approvers,
    r.human_changes_requested AS human_changes_requested,
    r.human_change_requesters AS human_change_requesters,
    p.additions AS additions,
    p.deletions AS deletions,
    p.changed_files AS changed_files,
    c.pr_number IN (SELECT pr_number FROM landed_prs) AS landed_via_trailer
FROM corpus AS c
LEFT JOIN pr_meta AS p ON c.pr_number = p.pr_number
LEFT JOIN decision_row AS d ON c.pr_number = d.pr_number
LEFT JOIN terminal_counts AS tc ON c.pr_number = tc.pr_number
LEFT JOIN last_attempt AS a ON c.pr_number = a.pr_number
LEFT JOIN human_reviews AS r ON c.pr_number = r.pr_number
ORDER BY pr_number DESC
"""
