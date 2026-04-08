-- Fetch AI advisor verdicts for a set of commits, for HUD overlay.
-- Returns the most recent verdict per (commit, signal_key) pair.
SELECT
    toString(suspect_commit) AS sha,
    signal_key,
    signal_source,
    workflow_name,
    verdict,
    confidence,
    summary,
    causal_reasoning,
    run_id,
    pr_number,
    timestamp
FROM misc.autorevert_advisor_verdicts
WHERE repo = {repo: String}
  AND suspect_commit IN {shas: Array(String)}
ORDER BY suspect_commit, signal_key, timestamp DESC
