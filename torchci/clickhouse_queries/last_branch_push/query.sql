-- Elapsed seconds since the last commit was pushed to pytorch/pytorch's main branch

SELECT
    DATE_DIFF('second', head_commit.timestamp, CURRENT_TIMESTAMP())
        AS push_seconds_ago
FROM
    push
WHERE
    push.ref = { branch : String }
    AND push.repository.owner.name = 'pytorch'
    AND push.repository.name = 'pytorch'
ORDER BY
    push.head_commit.timestamp DESC
LIMIT
    1
