WITH
    aggregated_tests AS (
        SELECT
            file,
            classname,
            name,
            countIf(
                failure_count = 0
                AND error_count = 0
                AND skipped_count = 0
                AND rerun_count = 0
            ) AS successful_run_count,
            avgOrNullIf(
                toFloat64(time),
                failure_count = 0
                AND error_count = 0
                AND skipped_count = 0
                AND rerun_count = 0
            ) AS average_duration_seconds,
            max(time_inserted) AS latest_run
        FROM tests.all_test_runs_by_name
        WHERE
            time_inserted > fromUnixTimestamp64Milli({cutoff_ms: Int64})
            AND time_inserted <= fromUnixTimestamp64Milli({anchor_ms: Int64})
            AND (name != '' OR classname != '' OR file != '')
            AND (
                {search: String} = ''
                OR positionCaseInsensitiveUTF8(file, {search: String}) > 0
                OR positionCaseInsensitiveUTF8(classname, {search: String}) > 0
                OR positionCaseInsensitiveUTF8(name, {search: String}) > 0
            )
        GROUP BY
            file,
            classname,
            name
    ),
    ranked_tests AS (
        SELECT
            name,
            classname,
            file,
            toUInt8(successful_run_count > 0) AS has_average_duration,
            ifNull(
                toUInt64(round(average_duration_seconds * 1000)),
                toUInt64(0)
            ) AS average_duration_ms,
            toString(toUnixTimestamp64Nano(latest_run)) AS last_run_ns
        FROM aggregated_tests
    )
SELECT
    name,
    classname,
    file,
    has_average_duration,
    average_duration_ms,
    last_run_ns
FROM ranked_tests
WHERE
    has_average_duration > {cursor_has_average_duration: UInt8}
    OR (
        has_average_duration = {cursor_has_average_duration: UInt8}
        AND average_duration_ms > {cursor_average_duration_ms: UInt64}
    )
    OR (
        has_average_duration = {cursor_has_average_duration: UInt8}
        AND average_duration_ms = {cursor_average_duration_ms: UInt64}
        AND name < {cursor_name: String}
    )
    OR (
        has_average_duration = {cursor_has_average_duration: UInt8}
        AND average_duration_ms = {cursor_average_duration_ms: UInt64}
        AND name = {cursor_name: String}
        AND classname < {cursor_classname: String}
    )
    OR (
        has_average_duration = {cursor_has_average_duration: UInt8}
        AND average_duration_ms = {cursor_average_duration_ms: UInt64}
        AND name = {cursor_name: String}
        AND classname = {cursor_classname: String}
        AND file < {cursor_file: String}
    )
ORDER BY
    has_average_duration ASC,
    average_duration_ms ASC,
    name DESC,
    classname DESC,
    file DESC
LIMIT {limit: UInt32}
SETTINGS optimize_aggregation_in_order = 1
