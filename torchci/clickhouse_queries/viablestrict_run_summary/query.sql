-- Summary for a single viable/strict commit's per-test page: one row per
-- (conclusion, duration bucket) with a count. The frontend derives both the
-- pass/fail/skip/flaky chip totals (sum over buckets) and the "Test Time
-- Distribution" histogram (sum over conclusions) from this single result.
--
-- Classification matches viablestrict_run_tests exactly (latest attempt per
-- config, new-process recovery, and job-conclusion gating), so the chip counts
-- line up with the table. Fetched once per commit (independent of paging/filter).
--
-- Buckets are static per-test total duration (seconds), fine-grained at the low
-- end where most unit tests live:
--   0:<0.1  1:0.1-0.25  2:0.25-0.5  3:0.5-1  4:1-2  5:2-3  6:3-5  7:5-10
--   8:10-20  9:20-30  10:30-60  11:60-120  12:120-300  13:>=300
WITH tests_jobs AS (
    SELECT
        j.id AS job_id,
        j.run_id AS workflow_id,
        j.workflow_name AS workflow_name,
        j.name AS job_name,
        j.run_attempt AS run_attempt,
        j.conclusion_kg AS conclusion,
        j.started_at AS started_at
    FROM
        default.workflow_job j FINAL
    WHERE
        j.id IN (
            SELECT id FROM materialized_views.workflow_job_by_head_sha
            WHERE head_sha = {sha: String}
        )
        -- Only the canonical on-main evaluation of the commit (see run_tests).
        AND j.head_branch = 'main'
        AND j.workflow_name IN {workflows: Array(String)}
        AND j.name NOT LIKE '%mem_leak_check%'
        AND j.name NOT LIKE '%rerun_disabled_tests%'
        AND j.name NOT LIKE '%unstable%'
),
job_conclusions AS (
    SELECT
        workflow_name,
        job_name,
        argMax(conclusion, run_attempt) AS job_conclusion
    FROM tests_jobs
    GROUP BY workflow_name, job_name
),
bounds AS (
    SELECT
        min(started_at) - INTERVAL 1 DAY AS lo,
        max(started_at) + INTERVAL 2 DAY AS hi
    FROM tests_jobs
),
test_rows AS (
    SELECT
        t.invoking_file AS invoking_file,
        t.file AS file,
        t.classname AS classname,
        t.name AS name,
        j.workflow_name AS workflow_name,
        j.job_name AS job_name,
        t.workflow_run_attempt AS run_attempt,
        t.time AS time,
        length(t.failure) AS failure_count,
        length(t.error) AS error_count,
        length(t.skipped) AS skipped_count,
        length(t.rerun) AS rerun_count
    FROM
        tests.all_test_runs t
        INNER JOIN tests_jobs j ON t.job_id = j.job_id
    WHERE
        t.workflow_id IN (SELECT workflow_id FROM tests_jobs)
        AND t.time_inserted BETWEEN (SELECT lo FROM bounds) AND (SELECT hi FROM bounds)
),
test_rows_latest AS (
    SELECT
        *,
        max(run_attempt) OVER (
            PARTITION BY invoking_file, file, classname, name, workflow_name, job_name
        ) AS max_attempt
    FROM test_rows
),
per_config AS (
    SELECT
        invoking_file,
        file,
        classname,
        name,
        workflow_name,
        job_name,
        SUM(time) AS time,
        SUM(rerun_count) AS config_reruns,
        countIf(failure_count + error_count > 0) AS fail_rows,
        countIf(failure_count + error_count = 0 AND skipped_count = 0) AS pass_rows,
        countIf(skipped_count > 0) AS skip_rows
    FROM test_rows_latest
    WHERE run_attempt = max_attempt
    GROUP BY
        invoking_file,
        file,
        classname,
        name,
        workflow_name,
        job_name
),
agg AS (
    SELECT
        pc.invoking_file AS invoking_file,
        pc.file AS file,
        pc.classname AS classname,
        pc.name AS name,
        SUM(pc.time) AS time,
        -- number of (config) runs of this test = rows in per_config
        count(*) AS runs,
        multiIf(
            countIf(
                pc.fail_rows > 0 AND pc.pass_rows = 0
                    AND jc.job_conclusion NOT IN ('success', 'skipped', '')
            ) > 0, 'failed',
            countIf(pc.fail_rows > 0) > 0 OR SUM(pc.config_reruns) > 0, 'flaky',
            countIf(pc.skip_rows > 0 AND pc.pass_rows = 0) = count(*), 'skipped',
            'success'
        ) AS conclusion
    FROM
        per_config pc
        LEFT JOIN job_conclusions jc
            ON pc.workflow_name = jc.workflow_name AND pc.job_name = jc.job_name
    GROUP BY
        pc.invoking_file,
        pc.file,
        pc.classname,
        pc.name
)
SELECT
    conclusion,
    multiIf(
        time < 0.1, 0,
        time < 0.25, 1,
        time < 0.5, 2,
        time < 1, 3,
        time < 2, 4,
        time < 3, 5,
        time < 5, 6,
        time < 10, 7,
        time < 20, 8,
        time < 30, 9,
        time < 60, 10,
        time < 120, 11,
        time < 300, 12,
        13
    ) AS bucket,
    count(*) AS cnt,
    SUM(runs) AS executions
FROM agg
GROUP BY conclusion, bucket
ORDER BY conclusion, bucket
