-- This query returns the list of DISABLED tests labels.  This powers
-- the disabled tests dashboard label dropdown list
SELECT
    DISTINCT arrayJoin(i.labels. 'name') AS label
FROM
    default .issues i FINAL
WHERE
    i.repository_url ='https://api.github.com/repos/pytorch/pytorch'
    AND i.title LIKE '%DISABLED%'
    AND NOT empty(label)
ORDER BY
    label ASC
