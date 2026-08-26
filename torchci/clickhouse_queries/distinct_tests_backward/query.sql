WITH
    multiIf(
        {sort_field: String} = 'file', toUInt8({cursor_file: String} = ''),
        {sort_field: String} = 'classname', toUInt8({cursor_classname: String} = ''),
        {sort_field: String} = 'name', toUInt8({cursor_name: String} = ''),
        {sort_field: String} = 'averageDuration', {cursor_has_average_duration: UInt8} = 0,
        toUInt8(0)
    ) AS cursor_sort_is_missing,
    multiIf(
        {sort_field: String} = 'file', lowerUTF8({cursor_file: String}),
        {sort_field: String} = 'classname', lowerUTF8({cursor_classname: String}),
        {sort_field: String} = 'name', lowerUTF8({cursor_name: String}),
        ''
    ) AS cursor_sort_text,
    multiIf(
        {sort_field: String} = 'averageDuration', {cursor_average_duration_ms: UInt64},
        {sort_field: String} = 'lastRun', toUInt64({cursor_last_run_ns: String}),
        toUInt64(0)
    ) AS cursor_sort_number,
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
    test_metrics AS (
        SELECT
            name,
            classname,
            file,
            toUInt8(successful_run_count > 0) AS has_average_duration,
            ifNull(
                toUInt64(round(average_duration_seconds * 1000)),
                toUInt64(0)
            ) AS average_duration_ms,
            toUInt64(toUnixTimestamp64Nano(latest_run)) AS last_run_ns_value
        FROM aggregated_tests
    ),
    sortable_tests AS (
        SELECT
            name,
            classname,
            file,
            has_average_duration,
            average_duration_ms,
            last_run_ns_value,
            multiIf(
                {sort_field: String} = 'file', toUInt8(file = ''),
                {sort_field: String} = 'classname', toUInt8(classname = ''),
                {sort_field: String} = 'name', toUInt8(name = ''),
                {sort_field: String} = 'averageDuration', has_average_duration = 0,
                toUInt8(0)
            ) AS sort_is_missing,
            multiIf(
                {sort_field: String} = 'file', lowerUTF8(file),
                {sort_field: String} = 'classname', lowerUTF8(classname),
                {sort_field: String} = 'name', lowerUTF8(name),
                ''
            ) AS sort_text,
            multiIf(
                {sort_field: String} = 'averageDuration', average_duration_ms,
                {sort_field: String} = 'lastRun', last_run_ns_value,
                toUInt64(0)
            ) AS sort_number
        FROM test_metrics
    )
SELECT
    name,
    classname,
    file,
    has_average_duration,
    average_duration_ms,
    toString(last_run_ns_value) AS last_run_ns
FROM sortable_tests
WHERE
    sort_is_missing < cursor_sort_is_missing
    OR (
        sort_is_missing = cursor_sort_is_missing
        AND (
            (
                {sort_ascending: UInt8} = 1
                AND (
                    tuple(sort_text, sort_number) < tuple(cursor_sort_text, cursor_sort_number)
                    OR (
                        tuple(sort_text, sort_number) = tuple(cursor_sort_text, cursor_sort_number)
                        AND tuple(name, classname, file) < tuple(
                            {cursor_name: String},
                            {cursor_classname: String},
                            {cursor_file: String}
                        )
                    )
                )
            )
            OR (
                {sort_ascending: UInt8} = 0
                AND (
                    tuple(sort_text, sort_number) > tuple(cursor_sort_text, cursor_sort_number)
                    OR (
                        tuple(sort_text, sort_number) = tuple(cursor_sort_text, cursor_sort_number)
                        AND tuple(name, classname, file) < tuple(
                            {cursor_name: String},
                            {cursor_classname: String},
                            {cursor_file: String}
                        )
                    )
                )
            )
        )
    )
ORDER BY
    sort_is_missing DESC,
    if({sort_ascending: UInt8} = 1, sort_text, '') DESC,
    if({sort_ascending: UInt8} = 0, sort_text, '') ASC,
    if({sort_ascending: UInt8} = 1, sort_number, toUInt64(0)) DESC,
    if({sort_ascending: UInt8} = 0, sort_number, toUInt64(0)) ASC,
    name DESC,
    classname DESC,
    file DESC
LIMIT {limit: UInt32}
SETTINGS optimize_aggregation_in_order = 1
