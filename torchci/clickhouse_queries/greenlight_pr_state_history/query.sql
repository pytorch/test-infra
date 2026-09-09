-- Latest greenlight state per reviewed commit, for a single PR.
--
-- Sibling of greenlight_pr_states, which collapses to one row per PR for a whole
-- Dr.CI sweep. This one collapses per head_sha instead, for the commit-scoped
-- HUD pages. run_id ahead of version is what makes the pick race-proof: a
-- superseded slower dispatch that finishes later still loses.
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
ORDER BY head_sha, run_id DESC, version DESC
LIMIT 1 BY head_sha
