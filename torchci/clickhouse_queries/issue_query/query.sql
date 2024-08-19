SELECT
    issue.number,
    issue.title,
    issue.html_url,
    issue.state,
    issue.body,
    issue.updated_at,
    issue.author_association
FROM
    issues AS issue
    ARRAY JOIN issue.labels AS labels
WHERE
    labels.name = {label: String}