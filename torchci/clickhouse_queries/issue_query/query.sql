SELECT
    issue.number,
    issue.title,
    issue.html_url,
    issue.state,
    issue.body,
    issue.updated_at,
    issue.author_association,
    arrayMap(x -> x.'name', issue.labels) AS labels
FROM
    default.issues AS issue FINAL
WHERE
    arrayExists(x -> x.'name' = {label: String}, issue.labels)
