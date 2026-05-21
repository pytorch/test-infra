-- Fetch AI advisor verdicts for a given PR number
SELECT
    suspect_commit AS sha,
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
FROM
    misc.autorevert_advisor_verdicts
WHERE
    repo = {repo: String}
    AND pr_number = {prNumber: Int64}
ORDER BY
    timestamp DESC
