SELECT
    COUNT(*) AS COUNT,
    WORKFLOW.NAME AS NAME
FROM
    WORKFLOW_JOB JOB
JOIN WORKFLOW_RUN WORKFLOW ON WORKFLOW.ID = JOB.RUN_ID
JOIN PUSH ON WORKFLOW.HEAD_COMMIT.'id' = PUSH.HEAD_COMMIT.'id'
WHERE
    JOB.NAME NOT LIKE '%generate-matrix%'
    AND JOB.NAME NOT LIKE '%unittests%'
    AND WORKFLOW.NAME NOT IN ('cron', 'Bandit', 'tests', 'Lint')
    AND PUSH.REF = 'refs/heads/nightly'
    AND PUSH.REPOSITORY.'owner'.'name' = 'pytorch'
    AND PUSH.REPOSITORY.'name' IN ('pytorch', 'vision', 'audio')
    AND JOB.CREATED_AT >= {startTime: DateTime64(3)}
    AND JOB.CREATED_AT < {stopTime: DateTime64(3)}
    AND JOB.CONCLUSION IN ('failure', 'timed_out', 'cancelled')
GROUP BY
    WORKFLOW.NAME
