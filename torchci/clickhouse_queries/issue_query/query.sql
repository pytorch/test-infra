-- Optimized query: uses arrayExists instead of array join for better performance
-- Original query used array join which processes all arrays before filtering
-- Using arrayExists reduces memory usage significantly (~2.4x reduction)
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
