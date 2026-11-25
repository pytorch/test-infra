-- Distribution of tests across build environments for one viable/strict commit:
-- one row per build name (the first segment of the job name, e.g.
-- "linux-jammy-aarch64-py3.10"), with the number of distinct tests that ran in
-- it. Powers the "tests by build" strip under the histogram.
--
-- Same scoping as viablestrict_run_tests (on-main, strict-blocking, time-window
-- pruned). uniqExact over the test identity dedupes shards and re-run attempts
-- automatically, so no latest-attempt window is needed here.
WITH tests_jobs AS (
    SELECT
        j.id AS job_id,
        j.run_id AS workflow_id,
        j.workflow_name AS workflow_name,
        j.name AS job_name,
        j.started_at AS started_at
    FROM
        default.workflow_job j FINAL
    WHERE
        j.id IN (
            SELECT id FROM materialized_views.workflow_job_by_head_sha
            WHERE head_sha = {sha: String}
        )
        AND j.head_branch = 'main'
        AND j.workflow_name IN {workflows: Array(String)}
        AND j.name NOT LIKE '%mem_leak_check%'
        AND j.name NOT LIKE '%rerun_disabled_tests%'
        AND j.name NOT LIKE '%unstable%'
),
bounds AS (
    SELECT
        min(started_at) - INTERVAL 1 DAY AS lo,
        max(started_at) + INTERVAL 2 DAY AS hi
    FROM tests_jobs
)
SELECT
    j.workflow_name AS workflow,
    splitByString(' / ', j.job_name)[1] AS build,
    uniqExact(t.invoking_file, t.file, t.classname, t.name) AS tests
FROM
    tests.all_test_runs t
    INNER JOIN tests_jobs j ON t.job_id = j.job_id
WHERE
    t.workflow_id IN (SELECT workflow_id FROM tests_jobs)
    AND t.time_inserted BETWEEN (SELECT lo FROM bounds) AND (SELECT hi FROM bounds)
GROUP BY
    workflow,
    build
ORDER BY
    tests DESC
