WITH
    coded_reverts as (
        SELECT
            FORMAT_TIMESTAMP(
                '%Y-%m-%d',
                DATE_TRUNC(:granularity, ic._event_time)
            ) AS bucket,
            REGEXP_EXTRACT(
                ic.body,
                '(-c|--classification)[\s =]+["'']?(\w+)["'']?',
                2
            ) AS code,
            COUNT(*) AS num
        FROM
            commons.issue_comment AS ic
            INNER JOIN (
                SELECT
                    issue_comment.issue_url,
                    MAX(issue_comment._event_time) AS event_time -- Use the max for when invalid revert commands are tried first
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
            AND ic._event_time >= PARSE_DATETIME_ISO8601(:startTime)
            AND ic._event_time <= PARSE_DATETIME_ISO8601(:stopTime)
            AND ic.user.login != 'pytorch-bot[bot]'
            AND REGEXP_EXTRACT(
                ic.body,
                '(-c|--classification)[\s =]+["'']?(\w+)["'']?',
                2
            ) IS NOT NULL
        GROUP BY
            code,
            bucket
    ),
    weekly_results as (
        (
            SELECT
                FORMAT_TIMESTAMP(
                    '%Y-%m-%d',
                    DATE_TRUNC(:granularity, push._event_time)
                ) AS bucket,
                'total' AS code,
                COUNT(*) AS num
            FROM
                push
            WHERE
                push.ref IN ('refs/heads/master', 'refs/heads/main')
                AND push.repository.owner.name = 'pytorch'
                AND push.repository.name = 'pytorch'
                AND (
                    push.head_commit.message LIKE 'Revert %'
                    OR push.head_commit.message LIKE 'Back out%'
                )
                AND push._event_time >= PARSE_DATETIME_ISO8601(:startTime)
                AND push._event_time <= PARSE_DATETIME_ISO8601(:stopTime)
            GROUP BY
                bucket
            ORDER BY
                bucket
        )
        UNION
        (
            SELECT
                bucket,
                code,
                num
            FROM
                coded_reverts
        )
        UNION
        (
            SELECT
                bucket,
                'non-ghfirst-total' AS code,
                SUM(num)
            FROM
                coded_reverts
            WHERE
                code != 'ghfirst'
            GROUP BY
                bucket
        )
    )
SELECT
    bucket,
    -- 2 week rolling average
    (
        SUM(num) OVER(
            PARTITION BY code
            ORDER BY
                bucket ROWS 1 PRECEDING
        )
    ) / 2.0 AS num,
    code,
FROM
    weekly_results
ORDER BY
    bucket DESC, code