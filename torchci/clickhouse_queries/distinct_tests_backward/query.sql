WITH
    maxMerge(last_run) AS latest_run,
    toUnixTimestamp64Nano(latest_run) AS latest_run_ns_value,
    toInt64({cursor_last_run_ns: String}) AS cursor_last_run_ns_value
SELECT
    name,
    classname,
    file,
    toString(latest_run_ns_value) AS last_run_ns
FROM tests.distinct_names
WHERE
    (name != '' OR classname != '' OR file != '')
    AND (
        {search: String} = ''
        OR positionCaseInsensitiveUTF8(file, {search: String}) > 0
        OR positionCaseInsensitiveUTF8(classname, {search: String}) > 0
        OR positionCaseInsensitiveUTF8(name, {search: String}) > 0
    )
GROUP BY
    name,
    classname,
    file
HAVING
    latest_run > fromUnixTimestamp64Milli({cutoff_ms: Int64})
    AND (
        latest_run_ns_value > cursor_last_run_ns_value
        OR (
            latest_run_ns_value = cursor_last_run_ns_value
            AND name < {cursor_name: String}
        )
        OR (
            latest_run_ns_value = cursor_last_run_ns_value
            AND name = {cursor_name: String}
            AND classname < {cursor_classname: String}
        )
        OR (
            latest_run_ns_value = cursor_last_run_ns_value
            AND name = {cursor_name: String}
            AND classname = {cursor_classname: String}
            AND file < {cursor_file: String}
        )
    )
ORDER BY
    latest_run ASC,
    name DESC,
    classname DESC,
    file DESC
LIMIT {limit: UInt32}
