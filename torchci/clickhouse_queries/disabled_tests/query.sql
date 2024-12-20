-- !!! Query is not converted to CH syntax yet.  Delete this line when it gets converted
--- This query returns the list of DISABLED tests together with their labels.  This powers
--- the disabled tests dashboard, contributing them to their owners.
WITH issues_with_labels AS (
  SELECT
    i.number,
    i.title,
    i.body,
    ARRAY_AGG(labels.value.name) AS labels,
    i.assignee.login AS assignee,
    i.html_url,
    i.updated_at,
  FROM
    commons.issues i,
    UNNEST (i.labels AS value) AS labels
  WHERE
    (
      i.state = : state
      OR : state = ''
    )
    AND i.repository_url = CONCAT(
      'https://api.github.com/repos/',
      : repo
    )
    AND i.title LIKE '%DISABLED%'
    AND (
      : platform = ''
      OR i.body LIKE CONCAT('%', : platform, '%')
      OR (NOT i.body LIKE '%Platforms: %')
    )
  GROUP BY
    i.number,
    i.title,
    i.body,
    i.assignee.login,
    i.html_url,
    i.updated_at
)
SELECT
  *
FROM
  issues_with_labels
WHERE
  ARRAY_CONTAINS(
    issues_with_labels.labels, 'skipped'
  )
  AND (
    : label = ''
    OR ARRAY_CONTAINS(
      issues_with_labels.labels, : label
    )
  )
  AND (
    : triaged = ''
    OR (
      : triaged = 'yes'
      AND ARRAY_CONTAINS(
        issues_with_labels.labels, 'triaged'
      )
    )
    OR (
      : triaged = 'no'
      AND NOT ARRAY_CONTAINS(
        issues_with_labels.labels, 'triaged'
      )
    )
  )
ORDER BY
  issues_with_labels.updated_at DESC