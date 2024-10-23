SELECT
    COUNT(issues.title) as number_of_open_disabled_tests
FROM
    default.issues final
WHERE
    issues.title LIKE '%DISABLED%'
    AND issues.state = {state: String}
