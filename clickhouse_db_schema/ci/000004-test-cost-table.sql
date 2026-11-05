-- noqa: disable=CP05,LT01
-- Runner time of test jobs by owner for the cost page
-- (/tests/[org]/[repo]/cost). 000005 adds the view that fills it.

-- Runner time of test jobs by day, repository, workflow file, test file,
-- test environment, runner labels and trigger: raw test time and both
-- attributions, occupancy and test-time ratio, each computed per job and then
-- summed. Rows with test_file '' are test jobs without test reports: their
-- whole wall time, environment unknown (their runner labels still name the
-- runner). Owners are joined at read time on (test_file, test_module), then
-- test_file; owners keeps them as of the computation. Filled by
-- test_cost_mv (000005), which recomputes recent days many times: readers
-- take each (repo, day)'s latest computed_at. Times are whole milliseconds,
-- as ci.* keeps them: executed and skipped time exactly, the shares (held,
-- occupancy, test ratio) rounded once per row.
CREATE TABLE test_cost
(
    -- The day the jobs started (UTC, default.workflow_job.started_at).
    `day` Date,
    -- default.workflow_job.repository_full_name.
    `repo` LowCardinality(String),
    -- The workflow file of the jobs' run (default.workflow_run.path), e.g.
    -- .github/workflows/pull.yml: it changes less often than the name.
    `workflow_path` LowCardinality(String),
    -- ci.tests.file: repo-relative path, or cpp/<binary> for C++ tests; ''
    -- for test jobs without test reports.
    `test_file` LowCardinality(String),
    -- The owner key below the file: the gtest suite (ci.tests.suite) for C++
    -- tests, '' for Python.
    `test_module` LowCardinality(String),
    -- ci.environments.id of the jobs: the environment the tests probed, not
    -- the runner's instance type; 0 for test jobs without test reports.
    `environments_id` UInt64,
    -- The jobs' runner labels, sorted (default.workflow_job.labels): the
    -- runner they asked for, on every row.
    `runner_labels` Array(LowCardinality(String)),
    -- What started the jobs' run: push:main (a push to main or master) or
    -- other, from default.workflow_run's event and head_branch; the values
    -- are defined in test_cost_mv (000005) only.
    `trigger` LowCardinality(String),
    -- The file's owners from ci.owners as of computed_at, by (test_file,
    -- test_module), then test_file; empty when none. Current owners come from
    -- ci.owners at read time.
    `owners` Array(LowCardinality(String)),
    -- Executed runs' time, summed: parallel runs each count in full.
    `executed_test_milliseconds` UInt64,
    -- Skipped runs' time, summed.
    `skipped_test_milliseconds` UInt64,
    -- Runner time while tests ran, split by occupancy: each report's span on
    -- a file (first run start to last run end, skipped runs included) shares
    -- every instant evenly with the spans running then.
    `held_milliseconds` UInt64,
    -- Job wall time split by occupancy: held time plus a share of setup and
    -- idle time (occupancy_runner_milliseconds - held_milliseconds).
    `occupancy_runner_milliseconds` UInt64,
    -- Job wall time split by test time instead, executed and skipped runs
    -- both (by occupancy when a job's runs took no time). Sums to the same
    -- total as occupancy_runner_milliseconds.
    `test_ratio_runner_milliseconds` UInt64,
    `computed_at` DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(computed_at)
PARTITION BY toYYYYMM(day)
ORDER BY (
    repo,
    day,
    workflow_path,
    test_file,
    test_module,
    environments_id,
    runner_labels,
    trigger
)
;
