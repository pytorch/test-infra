-- This query is used to annotate job on HUD
SELECT DISTINCT
    j.head_sha AS sha,
    CONCAT(w.name, ' / ', j.name) AS jobName,
    j.id,
    j.conclusion_kg as conclusion,
    j.html_url AS htmlUrl,
    CONCAT(
        'https://ossci-raw-job-status.s3.amazonaws.com/log/',
        j.id
    ) AS logUrl,
    DATE_DIFF('SECOND', j.started_at, j.completed_at) AS durationS,
    array(j.torchci_classification_kg. 'line') AS failureLines,
    j.torchci_classification_kg. 'captures' AS failureCaptures,
    array(j.torchci_classification_kg. 'line_num') AS failureLineNumbers
FROM
    workflow_job j FINAL
    JOIN workflow_run w FINAL on w.id = j.run_id
WHERE
    j.created_at >= {startTime: DateTime64(3) }
    AND j.created_at < {stopTime: DateTime64(3) }
    AND w.head_repository. 'full_name' = {repo: String }
    AND w.head_branch = {branch: String }
    AND w.event != 'workflow_run'
    AND w.event != 'repository_dispatch'
    AND j.conclusion_kg IN ('failure', 'cancelled', 'time_out')
