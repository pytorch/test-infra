SELECT
    j.id,
    j.name,
    j.conclusion,
    j.completed_at,
    j.html_url,
    j.head_sha,
    j.torchci_classification.captures as failure_captures,
FROM
    commons.workflow_job j
where
    ARRAY_CONTAINS(SPLIT(:shas, ','), j.head_sha)
    and j.conclusion in ('failure', 'cancelled')
