-- This is used by KPI pages to get the number of force pushes
SELECT
    formatDateTime(
        DATE_TRUNC({granularity: String }, issue_comment.created_at),
        '%Y-%m-%d'
    ) AS bucket,
    COUNT(DISTINCT issue_comment.issue_url) AS count
FROM
    default .issue_comment
WHERE
    issue_comment.body LIKE '%@pytorchbot merge -f%'
    AND created_at >= {startTime: DateTime64(3) }
    AND created_at < {stopTime: DateTime64(3) }
    AND issue_comment.user.login NOT LIKE '%pytorch-bot%'
    AND issue_comment.user.login NOT LIKE '%facebook-github-bot%'
    AND issue_comment.user.login NOT LIKE '%pytorchmergebot%'
group by
    bucket
order by
    bucket
