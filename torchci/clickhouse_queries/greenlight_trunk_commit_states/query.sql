-- GreenLight's verdict for the exact revision that produced each trunk commit.
--
-- Keyed by trunk commit sha, not by PR number, and that is the whole point. A PR
-- can land, be reverted, be changed, and land again, producing two trunk commits
-- from two different revisions with two different verdicts. Keying on pr_number
-- gives both commits whichever verdict is latest, which marks the first commit
-- with an approval that was never about it.
--
-- The join that makes the distinction is merges.last_commit_sha: the PR-branch
-- head at merge time, which is exactly what greenlight records as head_sha.
-- Mergebot rebases on merge, so merge_commit_sha (what the HUD shows) never
-- equals last_commit_sha (what greenlight reviewed) -- there is no way to join
-- these two tables on a sha directly, and this column is the bridge. Each
-- landing writes its own merges row, so each trunk commit resolves to its own
-- revision's verdict.
--
-- misc.greenlight_pr_state is append-only: emit_id ends the sort key, so every
-- row's key is unique and FINAL collapses nothing. Ordering run_id ahead of
-- version is what makes the per-revision pick race-proof -- a superseded slower
-- dispatch that finishes with a later version still loses to the newer
-- dispatch's higher run_id.
-- Terminal verdicts only, and that is what makes a revert read correctly.
--
-- A commit's mark answers "was this revision approved when it landed", which is
-- a fact about the past that a later event cannot unmake. revert_guard emits its
-- REVERTED row against the PR's head at revert time -- the same head_sha that
-- landed, if nothing was pushed since -- stamped next_run_id, so it outranks the
-- LAND and would erase the mark from a commit that genuinely was approved.
-- REVERTED is an exclusion marker carrying no reason, message or eval_hash: it
-- says the PR is out of review, not that the revision was bad. The in-flight and
-- retry markers are skipped for the same reason -- neither is a verdict.
--
-- The re-landing needs no special case. A reverted PR is excluded from review
-- permanently, so the fixed revision is never reviewed, has no row here at all,
-- and the INNER JOIN below simply drops its trunk commit: approved commit marked,
-- re-landed commit not.
WITH reviewed AS
(
    SELECT
        pr_number,
        head_sha,
        status
    FROM misc.greenlight_pr_state
    WHERE repo = {repo: String}
      AND status IN ('LAND', 'NO_LAND')
    ORDER BY pr_number, head_sha, run_id DESC, version DESC
    LIMIT 1 BY pr_number, head_sha
),
-- A failed merge attempt records an empty merge_commit_sha, and one merge can
-- record more than one row; without both guards a single trunk commit could
-- match several times and fan the join out.
landed AS
(
    SELECT
        pr_num,
        merge_commit_sha,
        last_commit_sha
    FROM merges
    WHERE
        owner = {owner: String}
        AND project = {project: String}
        AND dry_run = false
        AND merge_commit_sha != ''
        AND merge_commit_sha IN {shas: Array(String)}
    ORDER BY merge_commit_sha
    LIMIT 1 BY merge_commit_sha
)
SELECT
    landed.merge_commit_sha AS sha,
    reviewed.status AS status
FROM landed
INNER JOIN reviewed
    ON reviewed.pr_number = landed.pr_num
   AND reviewed.head_sha = landed.last_commit_sha
