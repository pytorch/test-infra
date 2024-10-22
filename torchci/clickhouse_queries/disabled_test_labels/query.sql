-- This query returns the list of DISABLED tests labels.  This powers
-- the disabled tests dashboard label dropdown list
SELECT
    DISTINCT arrayJoin(i.labels. 'name') AS label
FROM
    default .issues i FINAL
WHERE
    (
        has({states: Array(String) }, i.state)
        OR empty({states: Array(String) })
    )
    AND i.repository_url = CONCAT('https://api.github.com/repos/', {repo: String })
    AND i.title LIKE '%DISABLED%'
    AND NOT empty(label)
ORDER BY
    label ASC
