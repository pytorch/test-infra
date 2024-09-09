SELECT
    issue.number,
    issue.title,
    issue.html_url,
    issue.state,
    issue.body,
    issue.updated_at,
    issue.author_association,
FROM
    issues AS issue final
    array join issue.labels AS label
WHERE
    label.name = {label: String}
