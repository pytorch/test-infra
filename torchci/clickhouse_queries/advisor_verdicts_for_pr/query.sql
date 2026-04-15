-- Fetch AI advisor verdicts for a given PR number
SELECT
    suspect_commit AS suspectCommit,
    signal_key AS signalKey,
    signal_source AS signalSource,
    workflow_name AS workflowName,
    verdict,
    confidence,
    summary,
    causal_reasoning AS causalReasoning,
    run_id AS runId,
    timestamp
FROM
    misc.autorevert_advisor_verdicts
WHERE
    repo = {repo: String}
    AND pr_number = {prNumber: Int64}
ORDER BY
    timestamp DESC
