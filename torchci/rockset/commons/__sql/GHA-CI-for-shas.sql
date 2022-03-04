SELECT head_sha, head_branch, html_url, name, status, conclusion
FROM workflow_run
WHERE ARRAY_CONTAINS(SPLIT(:shas, ','), head_sha)