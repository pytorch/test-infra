-- Latest greenlight state per PR, batched across one Dr.CI sweep.
--
-- misc.greenlight_pr_state is append-only: emit_id ends the sort key, so every row's key
-- is unique. FINAL therefore collapses nothing, and argMax(..., version) would pick by
-- version alone. Ordering run_id ahead of version is what makes this read race-proof -- a
-- superseded slower dispatch that finishes with a later version still loses to the newer
-- dispatch's higher run_id.
--
-- A shadow evaluation carries no authority, so shadow sorts ahead of run_id (false first):
-- a PR's newest non-shadow row wins even when a later shadow row exists, and a PR yields a
-- shadow row only when it has no non-shadow row at all. The shadow column is what tells
-- that PR apart from one with no greenlight state.
SELECT
    pr_number,
    status,
    reason,
    message,
    head_sha,
    eval_job,
    run_id,
    version,
    shadow
FROM misc.greenlight_pr_state
WHERE
    repo = {repo: String}
    AND pr_number IN {prNumbers: Array(Int64)}
ORDER BY pr_number, shadow, run_id DESC, version DESC
LIMIT 1 BY pr_number
