SELECT
    COUNT(*) AS COUNT,
    JOB.NAME AS NAME
FROM
    WORKFLOW_JOB JOB
JOIN WORKFLOW_RUN WORKFLOW ON WORKFLOW.ID = JOB.RUN_ID
JOIN PUSH ON PUSH.HEAD_COMMIT.'id' = WORKFLOW.HEAD_COMMIT.'id'
WHERE
    JOB.NAME NOT LIKE '%generate-matrix%'
    AND JOB.NAME NOT LIKE '%unittests%'
    AND WORKFLOW.NAME NOT IN ('cron', 'Bandit', 'tests')
    AND PUSH.REF = 'refs/heads/nightly'
    AND PUSH.REPOSITORY.'owner'.'name' = 'pytorch'
    AND PUSH.REPOSITORY.'name' = {repo: String }
    AND JOB.CONCLUSION IN ('failure', 'timed_out', 'cancelled')
    AND JOB.COMPLETED_AT >= today() - 1
GROUP BY JOB.NAME
ORDER BY COUNT;
