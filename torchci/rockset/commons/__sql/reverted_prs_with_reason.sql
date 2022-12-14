SELECT
    ic._event_time revert_time,
    ic.user.login as reverter,
    REGEXP_EXTRACT(
        ic.body,
        '(-c|--classification)[\s =]+["'']?(\w+)["'']?',
        2
    ) as code,
    REGEXP_EXTRACT(
        ic.body,
        '(-m|--message)[\s =]+["'']?([^"'']+)["'']?',
        2
    ) as message,
    ic.html_url as comment_url
FROM
    commons.issue_comment AS ic
    INNER JOIN (
        SELECT
            issue_comment.issue_url,
            MAX(issue_comment._event_time) as event_time -- Use the max for when invalid revert commands are tried first
        FROM
            commons.issue_comment
        WHERE
            REGEXP_LIKE(
                issue_comment.body,
                ' *@pytorch(merge|)bot revert'
            )
        GROUP BY
            issue_comment.issue_url
    ) AS rc ON ic.issue_url = rc.issue_url
WHERE
    ic._event_time = rc.event_time
    AND ic._event_time >= PARSE_TIMESTAMP_ISO8601(:startTime)
    AND ic._event_time < PARSE_TIMESTAMP_ISO8601(:stopTime)
ORDER BY
    code DESC
