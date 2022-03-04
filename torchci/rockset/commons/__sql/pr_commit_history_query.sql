select
    push.head_commit.id as sha,
    SUBSTR(
        push.head_commit.message,
        0,
        STRPOS(push.head_commit.message, CHR(10)) -1
    ) as title
from
    pull_request pr
    LEFT JOIN push ON push.ref = CONCAT('refs/heads/', pr.head.ref)
where
    pr.number = :pr
    AND pr.html_url LIKE CONCAT('https://github.com/', :owner, '/', :repo, '/%')
    AND push.head_commit.id is not NULL
ORDER BY
	push._event_time