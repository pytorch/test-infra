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
WITH reviewed AS
(
    SELECT pr_number, head_sha, status, reason, message, eval_job, run_id, version
    FROM misc.greenlight_pr_state
    WHERE
        repo = {repo: String}
        AND pr_number = {prNumber: Int64}
    ORDER BY head_sha, run_id DESC, version DESC
    LIMIT 1 BY head_sha
),
-- A failed merge records an empty merge_commit_sha, and one merge can record
-- several rows; both guards keep the join from fanning out.
landed AS
(
    SELECT last_commit_sha, merge_commit_sha
    FROM merges
    WHERE
        owner = {owner: String}
        AND project = {project: String}
        AND pr_num = {prNumber: Int64}
        AND dry_run = false
        AND merge_commit_sha != ''
    ORDER BY merge_commit_sha
    LIMIT 1 BY merge_commit_sha
)
SELECT
    reviewed.pr_number AS pr_number,
    reviewed.head_sha AS head_sha,
    landed.merge_commit_sha AS merge_commit_sha,
    reviewed.status AS status,
    reviewed.reason AS reason,
    reviewed.message AS message,
    reviewed.eval_job AS eval_job,
    reviewed.run_id AS run_id,
    reviewed.version AS version
FROM reviewed
LEFT JOIN landed ON landed.last_commit_sha = reviewed.head_sha
