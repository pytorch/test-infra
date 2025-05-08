SELECT DISTINCT name AS workflow_name
FROM
    workflow_run
WHERE
    tupleElement(pull_requests[1], 'number') = { prNum: Int64 }
    AND head_sha = { headSha: String }
