SELECT
    COUNT(*) AS COUNT,
    JOB.NAME AS NAME
FROM
    WORKFLOW_JOB JOB
JOIN WORKFLOW_RUN WORKFLOW ON WORKFLOW.ID = JOB.RUN_ID
WHERE
    JOB.HEAD_BRANCH = 'main'
    AND WORKFLOW.NAME LIKE '%Binaries Validations%'
    AND WORKFLOW.EVENT = 'schedule'
    AND JOB.NAME LIKE concat('%', {channel: String}, '%')
    AND JOB.CONCLUSION IN ('failure', 'timed_out', 'cancelled')
    AND JOB.COMPLETED_AT >= today() - 1
GROUP BY JOB.NAME
ORDER BY COUNT DESC;
