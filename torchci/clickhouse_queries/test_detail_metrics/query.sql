SELECT
    avgOrNullIf(
        toFloat64(time),
        failure_count = 0
        AND error_count = 0
        AND skipped_count = 0
        AND rerun_count = 0
    ) AS average_duration_seconds,
    count() AS total_runs,
    countIf(
        failure_count = 0
        AND error_count = 0
        AND skipped_count = 0
        AND rerun_count = 0
    ) AS successful_runs,
    countIf(failure_count > 0 OR error_count > 0) AS failure_runs,
    countIf(
        failure_count = 0
        AND error_count = 0
        AND skipped_count > 0
    ) AS skipped_runs
FROM tests.all_test_runs_by_name
WHERE
    file = {file: String}
    AND classname = {classname: String}
    AND name = {name: String}
    AND time_inserted > fromUnixTimestamp64Milli({cutoff_ms: Int64})
    AND time_inserted <= fromUnixTimestamp64Milli({anchor_ms: Int64})
