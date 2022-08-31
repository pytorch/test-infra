SELECT
    COUNT(DISTINCT issue_comment.issue_url) AS count
FROM
    commons.issue_comment
WHERE
    issue_comment.body LIKE '%@pytorchbot merge -f%'
    AND _event_time >= PARSE_DATETIME_ISO8601(:startTime)
    AND _event_time < PARSE_DATETIME_ISO8601(:stopTime)
    AND issue_comment.user.login NOT LIKE '%pytorch-bot%'
    AND issue_comment.user.login NOT LIKE '%facebook-github-bot%'
    AND issue_comment.user.login NOT LIKE '%pytorchmergebot%'
