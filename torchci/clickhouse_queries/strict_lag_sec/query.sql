WITH master as (
    SELECT
        push.head_commit.timestamp as master
    FROM
        push
    WHERE
        push.ref = {head: String }
        AND push.repository.owner.name = {owner: String }
        AND push.repository.name = {repo: String }
        AND push.head_commit.id != ''
    ORDER BY
        push.head_commit.timestamp desc
    LIMIT
        1
), strict as (
    SELECT
        push.head_commit.timestamp as strict
    FROM
        push
    WHERE
        push.ref = 'refs/heads/viable/strict'
        AND push.repository.owner.name = {owner: String }
        AND push.repository.name = {repo: String }
        AND push.head_commit.id != ''
    ORDER BY
        push.head_commit.timestamp desc
    LIMIT
        1
)
SELECT
    DATE_DIFF('second', strict, master) as strict_lag_sec
FROM
    master,
    strict
