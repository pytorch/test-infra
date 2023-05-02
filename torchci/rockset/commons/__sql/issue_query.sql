SELECT
  issue.number,
  issue.title,
  issue.html_url,
  issue.state,
  issue.body,
  issue.updated_at,
  issue.author_association,
FROM
  issues AS issue CROSS
  JOIN UNNEST(issue.labels AS label) AS labels
WHERE
  labels.label.name = : label
  AND (
    ARRAY_CONTAINS(
      SPLIT(: associations, ','),
      LOWER(issue.author_association)
    )
    OR : associations = ''
  )