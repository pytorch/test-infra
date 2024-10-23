-- Take this query run against rockset and convert it to be clickhouse compatible: WITH     coded_reverts as (         SELECT             FORMAT_TIMESTAMP(                 '%Y-%m-%d',                 DATE_TRUNC(:granularity, ic.created)             ) AS bucket,             REGEXP_EXTRACT(                 ic.body,                 '(-c|--classification)[\s =]+["'']?(\w+)["'']?',                 2             ) AS code,             COUNT(*) AS num         FROM             commons.issue_comment AS ic             INNER JOIN (                 SELECT                     issue_comment.issue_url,                     MAX(issue_comment.created) AS created -- Use the max for when invalid revert commands are tried first                 FROM                     commons.issue_comment                 WHERE                     REGEXP_LIKE(                         issue_comment.body,                         ' *@pytorch(merge|)bot revert'                     )                 GROUP BY                     issue_comment.issue_url             ) AS rc ON ic.issue_url = rc.issue_url         WHERE             ic.created = rc.created             AND ic.created >= PARSE_DATETIME_ISO8601(:startTime)             AND ic.created <= PARSE_DATETIME_ISO8601(:stopTime)             AND ic.user.login != 'pytorch-bot[bot]'             AND REGEXP_EXTRACT(                 ic.body,                 '(-c|--classification)[\s =]+["'']?(\w+)["'']?',                 2             ) IS NOT NULL         GROUP BY             code,             bucket     ),     weekly_results as (         (             SELECT                 FORMAT_TIMESTAMP(                     '%Y-%m-%d',                     DATE_TRUNC(:granularity, push._event_time)                 ) AS bucket,                 'total' AS code,                 COUNT(*) AS num             FROM                 push             WHERE                 push.ref IN ('refs/heads/master', 'refs/heads/main')                 AND push.repository.owner.name = 'pytorch'                 AND push.repository.name = 'pytorch'                 AND (                     push.head_commit.message LIKE 'Revert %'                     OR push.head_commit.message LIKE 'Back out%'                 )                 AND push._event_time >= PARSE_DATETIME_ISO8601(:startTime)                 AND push._event_time <= PARSE_DATETIME_ISO8601(:stopTime)             GROUP BY                 bucket             ORDER BY                 bucket         )         UNION         (             SELECT                 bucket,                 code,                 num             FROM                 coded_reverts         )         UNION         (             SELECT                 bucket,                 'non-ghfirst-total' AS code,                 SUM(num)             FROM                 coded_reverts             WHERE                 code != 'ghfirst'             GROUP BY                 bucket         )     ) SELECT     bucket,     -- 2 week rolling average     (         SUM(num) OVER(             PARTITION BY code             ORDER BY                 bucket ROWS 1 PRECEDING         )     ) / 2.0 AS num,     code, FROM     weekly_results ORDER BY     bucket DESC, code
WITH coded_reverts AS (
    SELECT
        formatDateTime(toStartOfInterval(ic.created_at, interval 1 WEEK), '%Y-%m-%d') AS bucket,
        extract(ic.body, '(?:-c|--classification)[\s =]+["\']?(\w+)["\']?') AS code,
        COUNT(*) AS num
    FROM
        default.issue_comment AS ic
    INNER JOIN (
        SELECT
            issue_comment.issue_url,
            MAX(issue_comment.created_at) AS created
        FROM
            default.issue_comment
        WHERE
            match(issue_comment.body, '@pytorch(merge|)bot revert')
        GROUP BY
            issue_comment.issue_url
        ) AS rc ON ic.issue_url = rc.issue_url
    WHERE
        ic.created_at = rc.created
        AND ic.created_at >= {startTime: DateTime64(3)}
        AND ic.created_at <= {stopTime: DateTime64(3)}
        AND ic.user.login != 'pytorch-bot[bot]'
        AND extract(ic.body, '(?:-c|--classification)[\s =]+["\']?(\w+)["\']?') IS NOT NULL
    GROUP BY
        code,
        bucket
),
weekly_results AS (
    SELECT
        formatDateTime(toStartOfInterval(push.head_commit.timestamp, interval 1 WEEK), '%Y-%m-%d') AS bucket,
        'total' AS code,
        COUNT(*) AS num
    FROM
        push
    WHERE
        push.ref IN ('refs/heads/master', 'refs/heads/main')
        AND push.repository.owner.login = 'pytorch'
        AND push.repository.name = 'pytorch'
        AND (
            push.head_commit.message LIKE 'Revert %'
            OR push.head_commit.message LIKE 'Back out%'
        )
        AND push.head_commit.timestamp >= {startTime: DateTime64(3)}
        AND push.head_commit.timestamp <= {stopTime: DateTime64(3)}
    GROUP BY
        bucket
    UNION ALL
    SELECT
        bucket,
        code,
        num
    FROM
        coded_reverts
    UNION ALL
    SELECT
        bucket,
        'non-ghfirst-total' AS code,
        SUM(num) AS num
    FROM
        coded_reverts
    WHERE
        code != 'ghfirst'
    GROUP BY
        bucket
)
SELECT
    bucket,
    SUM(num) OVER (
        PARTITION BY code
        ORDER BY
            bucket ROWS BETWEEN 1 PRECEDING AND CURRENT ROW
    ) / 2.0 AS num,
    code
FROM
    weekly_results
ORDER BY
    bucket DESC,
    code