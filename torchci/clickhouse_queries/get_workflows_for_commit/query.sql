SELECT DISTINCT
    name as workflow_name
FROM
    workflow_run final
WHERE
    tupleElement(pull_requests[1], 'number') = { prNum: Int64 }
    AND head_sha = { headSha: String }
