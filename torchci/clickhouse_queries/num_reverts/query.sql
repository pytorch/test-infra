-- This query is used on the kpi page to break down the types
-- of reverts that have occurred in the pytorch/pytorch repo over time.

WITH coded_reverts AS (
    SELECT
        formatDateTime(toStartOfWeek(ic.created_at), '%Y-%m-%d') AS bucket,
        extract(ic.body, '(?:-c|--classification)[\s =]+["\']?(\w+)["\']?')
            AS code,
        COUNT(*) AS num
    FROM
        default.issue_comment AS ic FINAL
    INNER JOIN (
        SELECT
            issue_comment.issue_url,
            MAX(issue_comment.created_at) AS created
        FROM
            default.issue_comment FINAL
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
        AND extract(
            ic.body, '(?:-c|--classification)[\s =]+["\']?(\w+)["\']?'
        ) IS NOT NULL
    GROUP BY
        code,
        bucket
),

weekly_results AS (
    SELECT
        formatDateTime(toStartOfWeek(push.head_commit.timestamp), '%Y-%m-%d')
            AS bucket,
        'total' AS code,
        COUNT(*) AS num
    FROM
        push FINAL
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
        cr.bucket,
        'non-ghfirst-total' AS code,
        SUM(cr.num) AS num
    FROM
        coded_reverts AS cr
    WHERE
        cr.code != 'ghfirst'
    GROUP BY
        cr.bucket
)

SELECT
    bucket,
    SUM(num) OVER (
        PARTITION BY code
        ORDER BY
            bucket
        ROWS BETWEEN 1 PRECEDING AND CURRENT ROW
    ) / 2.0 AS num,
    code
FROM
    weekly_results
ORDER BY
    bucket DESC,
    code
