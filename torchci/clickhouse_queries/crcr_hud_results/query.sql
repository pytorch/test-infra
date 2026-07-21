SELECT
    pr_number,
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
    pr_number IN {prNums: Array(Int64)}
    AND pr_number > 0
    AND downstream_repo != 'pytorch/crcr-test'
ORDER BY
    pr_number, downstream_repo, job_name
