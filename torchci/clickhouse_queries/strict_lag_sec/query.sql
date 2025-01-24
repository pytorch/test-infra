WITH master AS (
    SELECT push.head_commit.timestamp AS master
    FROM
        push
    WHERE
        push.ref = {head: String }
        AND push.repository.owner.name = {owner: String }
        AND push.repository.name = {repo: String }
        AND push.head_commit.id != ''
    ORDER BY
        push.head_commit.timestamp DESC
    LIMIT
        1
),

strict AS (
    SELECT push.head_commit.timestamp AS strict
    FROM
        push
    WHERE
        push.ref = 'refs/heads/viable/strict'
        AND push.repository.owner.name = {owner: String }
        AND push.repository.name = {repo: String }
        AND push.head_commit.id != ''
    ORDER BY
        push.head_commit.timestamp DESC
    LIMIT
        1
)

SELECT DATE_DIFF('second', strict, master) AS strict_lag_sec
FROM
    master,
    strict
