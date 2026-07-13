SELECT
    pytorch_head_sha,
    downstream_repo,
    downstream_repo_level,
    workflow_name,
    job_name,
    check_run_id,
    run_id,
    run_attempt,
    status,
    conclusion,
    workflow_run_url,
    duration_seconds,
    failed_tests_json
FROM
    default.crcr_workflow_job FINAL
WHERE
    pytorch_head_sha IN {shas: Array(String)}
ORDER BY
    pytorch_head_sha, downstream_repo, job_name
