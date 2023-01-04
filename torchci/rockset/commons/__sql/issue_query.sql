SELECT
    issue.number,
    issue.title,
    issue.html_url,
    issue.state,
    issue.body,
    issue.updated_at,
from
    issues as issue
    cross join UNNEST(issue.labels as label) as labels
where
    labels.label.name = :label
