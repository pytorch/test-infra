WITH runner_label_map AS(
    SELECT DISTINCT
    machine_type,
    arrayJoin(runner_labels) AS runner_label
    FROM fortesting.oss_ci_queue_time_histogram
    WHERE time >= {startTime: DateTime64} AND time < {endTime: DateTime64}
)


SELECT
    arrayDistinct(groupArray(repo)) AS repos,
    arrayDistinct(groupArray(workflow_name)) AS workf


    low_names,
    arrayDistinct(groupArray(job_name)) AS job_names,
    arrayDistinct(groupArray(machine_type)) AS machine_types,
FROM fortesting.oss_ci_queue_time_histogram
WHERE time >= {startTime: DateTime64} AND time < {endTime: DateTime64}
