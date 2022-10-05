SELECT
    issue.number,
    issue.title,
    issue.html_url,
    issue.state,
    issue.body
from
    issues as issue
    cross join UNNEST(issue.labels as label) as labels
where
    labels.label.name = :label
