-- Per-class test time for each build environment and test config, from ci.runs
-- for the jobs on the most recent viable/strict commits. Same method as
-- test_times/per_file, per test class:
--
-- Within a job, a class's time is the sum of its test case durations plus the
-- gaps between consecutive cases capped at 5 seconds. The short gaps are
-- process spawn and setup that case timestamps miss (e.g. distributed tests);
-- longer gaps (e.g. run_test.py running other files between a file's serial and
-- parallel passes) are not the class's time. Cases that overlap under
-- pytest-xdist add no gap, so the time stays summed test time, which
-- run_test.py divides by the worker count. Each run sums its jobs, and the
-- result is the median over runs.
WITH most_recent_strict_commits AS (
    SELECT push.head_commit.id AS sha
    FROM
        default.push
    WHERE
        push.ref = 'refs/heads/viable/strict'
        AND push.repository.full_name = 'pytorch/pytorch'
    ORDER BY
        push.head_commit.timestamp DESC
    LIMIT
        10
),

job AS (
    SELECT
        j.id AS id,
        any(j.name) AS name,
        any(j.run_id) AS run_id,
        min(j.started_at) AS started_at
    FROM
        default.workflow_job j
    WHERE j.id IN (
        SELECT id FROM materialized_views.workflow_job_by_head_sha
        WHERE head_sha IN (SELECT sha FROM most_recent_strict_commits)
    )
    GROUP BY
        j.id
),

python_test AS (
    SELECT
        id,
        file,
        suite
    FROM
        ci.tests FINAL
    WHERE
        language = 'python'
),

-- ci.runs is a ReplacingMergeTree: re-ingested reports can leave duplicate
-- copies until a merge. Collapse them on the table's sorting key (FINAL over
-- these jobs is too slow).
run AS (
    SELECT
        tests_id,
        github_workflow_job_id,
        started_at,
        any(ended_at) AS ended_at
    FROM
        ci.runs
    WHERE
        github_workflow_job_id IN (SELECT id FROM job)
        AND started_at >= (SELECT MIN(started_at) FROM job)
    GROUP BY
        tests_id,
        environments_id,
        env_vars_id,
        started_at,
        github_workflow_job_id,
        rerun_number
),

case_time AS (
    SELECT
        r.github_workflow_job_id AS job_id,
        t.file AS file,
        t.suite AS classname,
        dateDiff('millisecond', r.started_at, r.ended_at) / 1000
        + if(
            count() OVER w = 0,
            0,
            greatest(
                0,
                least(
                    5,
                    dateDiff(
                        'millisecond', max(r.ended_at) OVER w, r.started_at
                    ) / 1000
                )
            )
        ) AS time
    FROM
        run r
    INNER JOIN python_test t ON r.tests_id = t.id
    WINDOW w AS (
        PARTITION BY r.github_workflow_job_id, t.file, t.suite
        ORDER BY r.started_at
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    )
),

class_duration_per_run AS (
    SELECT
        c.file AS file,
        c.classname AS classname,
        SUM(c.time) AS time,
        REGEXP_EXTRACT(job.name, '^(.*) /', 1) AS base_name,
        REGEXP_EXTRACT(job.name, '/ test(?:-osdc)? \(([\w-]*),', 1)
            AS test_config
    FROM
        case_time c
    INNER JOIN job ON c.job_id = job.id
    GROUP BY
        c.file,
        c.classname,
        base_name,
        test_config,
        job.run_id
)

SELECT
    replaceRegexpAll(file, '^test/|\.py$', '') AS file,
    classname,
    base_name,
    test_config,
    quantileExact(0.5)(time) AS time
FROM
    class_duration_per_run
GROUP BY
    file,
    classname,
    base_name,
    test_config
ORDER BY
    base_name,
    test_config,
    file,
    classname
