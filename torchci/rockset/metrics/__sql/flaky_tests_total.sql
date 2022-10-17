SELECT
    COUNT(issues.title) as number_of_open_flaky_tests,
FROM
    commons.issues
WHERE
    issues.title LIKE '%DISABLED%'
    AND issues.state = :stat
