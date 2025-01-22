SELECT COUNT(issues.title) AS number_of_open_disabled_tests
FROM
    default.issues FINAL
WHERE
    issues.title LIKE '%DISABLED%'
    AND issues.state = {state: String}
