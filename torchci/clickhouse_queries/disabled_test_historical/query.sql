WITH day_info AS (
    SELECT
        day,
        lagInFrame(day, 1, day) OVER (
            ORDER BY
                day ASC ROWS BETWEEN UNBOUNDED PRECEDING
                AND UNBOUNDED FOLLOWING
        ) AS prev_day,
        leadInFrame(day, 1, day) OVER (
            ORDER BY
                day ASC ROWS BETWEEN UNBOUNDED PRECEDING
                AND UNBOUNDED FOLLOWING
        ) AS next_day
    FROM
        misc.disabled_tests_historical
    WHERE
        day >= {startTime: DateTime64(3) }
        AND day <= {stopTime: DateTime64(3) }
    GROUP BY
        day
),
tests AS (
    SELECT
        DISTINCT t.day AS day,
        t.name AS name,
        d.prev_day AS prev_day,
        d.next_day AS next_day
    FROM
        misc.disabled_tests_historical t
        JOIN day_info d ON d.day = t.day
        JOIN default .issues i ON i.number = t.issueNumber
    WHERE
        (
            {platform: String } = ''
            OR arrayExists(
                x -> x LIKE CONCAT('%', {platform: String }, '%'),
                t.platforms
            )
        )
        AND (
            {label: String } = ''
            OR arrayExists(l -> l. 'name' = {label: String }, i.labels)
        )
        AND (
            {triaged: String } = ''
            OR (
                {triaged: String } = 'yes'
                AND arrayExists(l -> l. 'name' = 'triaged', i.labels)
            )
            OR (
                {triaged: String } = 'no'
                AND NOT arrayExists(l -> l. 'name' = 'triaged', i.labels)
            )
        )
        AND i.html_url LIKE '%pytorch/pytorch%'
),
new_tests AS (
    SELECT
        t.day AS day,
        countIf(p.name = '') AS new,
        count(*) AS curr
    FROM
        tests t
        LEFT JOIN tests p ON p.name = t.name
        AND p.day = t.prev_day
    GROUP BY
        t.day
),
deleted_tests AS (
    SELECT
        p.next_day AS day,
        COUNT(*) AS deleted
    FROM
        tests p
        LEFT JOIN tests t ON t.name = p.name
        AND t.day = p.next_day
    WHERE
        t.name = ''
    GROUP BY
        p.next_day
)
SELECT
    d.day AS day,
    new .curr AS count,
    new .new as new,
    deleted.deleted as deleted
FROM
    day_info d
    LEFT JOIN new_tests new ON new .day = d.day
    LEFT JOIN deleted_tests deleted ON deleted.day = d.day
ORDER BY
    day
