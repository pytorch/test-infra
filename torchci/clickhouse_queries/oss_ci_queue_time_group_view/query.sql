select
from
    fortesting.oss_ci_queue_time_histogram as h final
where
    h.date > {startTime: DateTime64()}
    and h.date < {stopTime: DateTime64()}
    and h.repo in {selectedRepos: Array(String)}
group by
    granularity_bucket,
    repo
order by
    granularity_bucket asc


SELECT
    job_name,
    workflow_name,
    arrayMap(i -> arraySum(arrayMap(arr -> arr[i], grouped_arrays)), range(1, length(grouped_arrays[1]))) AS summed_values
FROM (
    SELECT
        job_name,
        workflow_name,
        time,
        groupArray(histogram) AS grouped_arrays
    FROM oss_ci_queue_time_histogram
    GROUP BY job_name, workflow_name, time
)




SELECT
    job_name,
    arrayMap(i -> arraySum(arrayMap(arr -> arr[i], grouped_arrays)), range(1, length(grouped_arrays[1]))) AS summed_values
FROM (
    SELECT
        job_name,
        groupArray(histogram) AS grouped_arrays
    FROM oss_ci_queue_time_histogram
    WHERE time> '2025-04-08 06:30:00' And time <'2025-04-09 08:30:00'
    GROUP BY job_name
)
where job_name in ['manywheel-py3_13-cpu-s390x-build / build','linux-focal-py3.13-clang10 / test (default, 5, 5, ephemeral.linux.4xlarge)']


WITH selected_data AS(
SELECT
    time,
    groupArray(histogram) as al
FROM oss_ci_queue_time_histogram
WHERE time> '2025-04-08 06:30:00' And time <'2025-04-09 08:30:00' and job_name in ['manywheel-py3_13-cpu-s390x-build / build','linux-focal-py3.13-clang10 / test (default, 5, 5, ephemeral.linux.4xlarge)']
group by time
)
SELECT
   selected_data.time,
   arrayMap(i -> arraySum(arrayMap(arr -> arr[i], selected_data.al)), range(1, length(al[1]))) AS summed_values
FROM selected_data
