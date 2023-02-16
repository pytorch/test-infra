SELECT
    issue_comment.issue_url
FROM
    commons.issue_comment
WHERE
    REGEXP_LIKE(issue_comment.body, '@pytorch(merge)?bot merge -f')
    AND issue_comment.user.login NOT LIKE '%pytorch-bot%'
    AND issue_comment.user.login NOT LIKE '%facebook-github-bot%'
    AND issue_comment.user.login NOT LIKE '%pytorchmergebot%'
    AND ARRAY_CONTAINS(SPLIT(:issueUrls, ','), issue_comment.issue_url)
GROUP BY
    issue_comment.issue_url
