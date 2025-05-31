WITH day_info as (
    SELECT
        day,
        lagInFrame(day, 1, day) OVER (
            ORDER BY
                day asc ROWS BETWEEN UNBOUNDED PRECEDING
                AND UNBOUNDED FOLLOWING
        ) AS prev_day,
        leadInFrame(day, 1, day) OVER (
            ORDER BY
                day asc ROWS BETWEEN UNBOUNDED PRECEDING
                AND UNBOUNDED FOLLOWING
        ) AS next_day
    FROM
        misc.disabled_tests_historical
    where
        day >= {startTime: DateTime64(3) }
        and day <= {stopTime: DateTime64(3) }
    group by
        day
),
tests as (
    select
        distinct t.day as day,
        t.name as name,
        d.prev_day as prev_day,
        d.next_day as next_day
    from
        misc.disabled_tests_historical t
        join day_info d on d.day = t.day
        join default.issues i on i.number = t.issueNumber
    where
        (
            {platform: String } = ''
            OR arrayExists(x -> x like CONCAT('%', {platform: String }, '%'), t.platforms)
        )
        and (
            {label: String } = ''
            OR arrayExists(l -> l.'name' = {label: String}, i.labels)
        )
        AND (
            {triaged: String } = ''
            OR (
                {triaged: String } = 'yes'
                AND arrayExists(l -> l.'name' = 'triaged', i.labels)
            )
            OR (
                {triaged: String } = 'no'
                AND NOT arrayExists(l -> l.'name' = 'triaged', i.labels)
            )
        )
        and i.html_url like '%pytorch/pytorch%'
),
new_tests AS (
    SELECT
        t.day as day,
        countIf(p.name = '') as new,
        count(*) as curr
    FROM
        tests t
        LEFT JOIN tests p ON p.name = t.name
        AND p.day = t.prev_day
    GROUP BY
        t.day
),
deleted_tests AS (
    SELECT
        p.next_day as day,
        COUNT(*) AS deleted
    FROM
        tests p
        left join tests t on t.name = p.name
        and t.day = p.next_day
    WHERE
        t.name = ''
    GROUP BY
        p.next_day
)
SELECT
    n.day,
    n.curr as count,
    n.new,
    d.deleted
FROM
    new_tests n
    left JOIN deleted_tests d ON n.day = d.day
ORDER BY
    day
