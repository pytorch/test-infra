-- noqa: disable=CP05,LT01
-- Runner time of test jobs by owner for the cost page
-- (/tests/[org]/[repo]/cost), staged in the sandbox before ci. 000005 adds
-- the view that fills it.

-- Runner time of test jobs by day, repository, workflow, test file and
-- machine: raw test time and both attributions, occupancy and test-time
-- ratio, each computed per job and then summed. Rows with test_file '' are
-- test jobs without test reports: their whole wall time, machine unknown.
-- Owners are joined at read time on (test_file, test_module), then
-- test_file; owners_snapshot keeps them as of the computation. Filled by
-- test_cost_mv (000005), which recomputes recent days many times: readers
-- take each (repo, day)'s latest computed_at.
CREATE TABLE test_cost
(
    -- The day the jobs started (UTC, default.workflow_job.started_at).
    `day` Date,
    -- default.workflow_job.repository_full_name.
    `repo` LowCardinality(String),
    -- lower(default.workflow_job.workflow_name).
    `workflow_name` LowCardinality(String),
    -- ci.tests.file: repo-relative path, or cpp/<binary> for C++ tests; ''
    -- for test jobs without test reports.
    `test_file` LowCardinality(String),
    -- The owner key below the file: the gtest suite (ci.tests.suite) for C++
    -- tests, '' for Python.
    `test_module` LowCardinality(String),
    -- ci.environments.id of the jobs; 0 for test jobs without test reports.
    `environments_id` UInt64,
    -- The file's owners from ci.owners when the day was computed, by
    -- (test_file, test_module), then test_file; empty when none.
    `owners_snapshot` Array(LowCardinality(String)),
    -- Executed runs' time, summed: parallel runs each count in full.
    `executed_test_seconds` Float64,
    -- Skipped runs' time, summed.
    `skipped_test_seconds` Float64,
    -- Runner time while tests ran, split by occupancy: each report's span on
    -- a file (first run start to last run end, skipped runs included) shares
    -- every instant evenly with the spans running then.
    `held_seconds` Float64,
    -- Job wall time split by occupancy: held_seconds plus a share of setup
    -- and idle time (occupancy_runner_seconds - held_seconds).
    `occupancy_runner_seconds` Float64,
    -- Job wall time split by executed test time instead. Sums to the same
    -- total as occupancy_runner_seconds.
    `test_ratio_runner_seconds` Float64,
    `computed_at` DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(computed_at)
PARTITION BY toYYYYMM(day)
ORDER BY (repo, day, workflow_name, test_file, test_module, environments_id)
;
