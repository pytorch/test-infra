-- GreenLight's verdict for the revision that produced each trunk commit.
--
-- Keyed by trunk commit, not by PR: a PR can land, be reverted, be fixed and
-- land again, and each landing needs its own verdict. merges.last_commit_sha is
-- the PR head at merge time, which is what greenlight records as head_sha;
-- mergebot rebases, so merge_commit_sha never matches it directly.
--
-- Terminal verdicts only. A revert emits a REVERTED row against the same
-- head_sha with a higher run_id, which would otherwise erase the approval from
-- a commit that was genuinely approved when it landed. The fixed re-landing is
-- never reviewed again, so it has no row and the join drops it.
--
-- Shadow rows carry no authority, and the exclusion sits in WHERE so they are
-- gone before LIMIT 1 BY picks a winner: filtering after the collapse would
-- hide the genuine verdict a later shadow row outranked.
WITH reviewed AS
(
    SELECT pr_number, head_sha, status
    FROM misc.greenlight_pr_state
    WHERE repo = {repo: String}
      AND status IN ('LAND', 'NO_LAND')
      AND shadow = false
    ORDER BY pr_number, head_sha, run_id DESC, version DESC
    LIMIT 1 BY pr_number, head_sha
),
-- A failed merge records an empty merge_commit_sha, and one merge can record
-- several rows; both guards keep the join from fanning out.
landed AS
(
    SELECT pr_num, merge_commit_sha, last_commit_sha
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
