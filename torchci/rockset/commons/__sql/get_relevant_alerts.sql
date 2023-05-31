WITH
    filtered_table as (
        SELECT
            *
        FROM
            commons.alerts
        WHERE
            repo = :repo
            and organization = :organization
            and closed = false
            or (
                PARSE_DATETIME_ISO8601(timestamp) > (CURRENT_TIME() - INTERVAL 1 DAY)
            )
    )
SELECT
    *
FROM
    filtered_table alerts
    INNER JOIN (
        SELECT
            AlertObject,
            MAX(filtered_table.timestamp)
        FROM
            filtered_table
        GROUP BY
            AlertObject
    ) b ON alerts.AlertObject = b.AlertObject
