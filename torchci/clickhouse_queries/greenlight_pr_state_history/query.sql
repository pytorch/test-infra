-- Latest greenlight state per reviewed commit, for a single PR.
--
-- Sibling of greenlight_pr_states, which collapses to one row per PR for a whole
-- Dr.CI sweep. This one takes one PR and collapses per head_sha instead, because
-- the HUD's commit and PR pages are commit-scoped: they ask what GreenLight said
-- about the commit on screen, not only what it last said about the PR. The
-- caller recovers the PR-level answer from the same result by re-applying the
-- (run_id DESC, version DESC) order across shas.
--
-- misc.greenlight_pr_state is append-only: emit_id ends the sort key, so every
-- row's key is unique. FINAL therefore collapses nothing, and argMax(...,
-- version) would pick by version alone. Ordering run_id ahead of version is what
-- makes this read race-proof -- a superseded slower dispatch that finishes with
-- a later version still loses to the newer dispatch's higher run_id.
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
