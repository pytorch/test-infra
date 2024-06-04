--- This query returns the list of DISABLED tests labels.  This powers
--- the disabled tests dashboard label dropdown list
SELECT
  DISTINCT labels.value.name AS label,
FROM
  commons.issues i,
  UNNEST (i.labels AS value) AS labels
WHERE
  (
    ARRAY_CONTAINS(
      SPLIT(: states, ','),
      i.state
    )
    OR : states = ''
  )
  AND i.repository_url = CONCAT(
    'https://api.github.com/repos/',
    : repo
  )
  AND i.title LIKE '%DISABLED%'
ORDER BY
  label ASC