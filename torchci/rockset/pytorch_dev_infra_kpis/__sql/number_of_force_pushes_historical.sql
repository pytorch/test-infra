SELECT
    FORMAT_TIMESTAMP('%Y-%m-%d', DATE_TRUNC(:granularity, issue_comment.created)) AS bucket,
    COUNT(DISTINCT issue_comment.issue_url) AS count
FROM
    commons.issue_comment
WHERE
    issue_comment.body LIKE '%@pytorchbot merge -f%'
    AND created >= PARSE_DATETIME_ISO8601(:startTime)
    AND created < PARSE_DATETIME_ISO8601(:stopTime)
    AND issue_comment.user.login NOT LIKE '%pytorch-bot%'
    AND issue_comment.user.login NOT LIKE '%facebook-github-bot%'
    AND issue_comment.user.login NOT LIKE '%pytorchmergebot%'
group by
    bucket
order by
    bucket
