-- noqa: disable=CP05,LT01
-- Runner-hours for the cost page (/tests/[org]/[repo]/cost), staged in the
-- sandbox before ci: per-job facts from ci.runs (machine, test config, raw
-- test time and occupancy by owner), and runner-hours by day, workflow, test
-- config, owner, machine and runner label. 000005 adds the views that fill
-- them.

-- One row per test job that uploaded reports: its machine, test config, and
-- each owner's raw test time and occupancy within the job. Filled by
-- cost_job_facts_mv (000005); the latest computed_at per (day, job) stands.
CREATE TABLE cost_job_facts
(
    -- The day the job started (UTC, default.workflow_job.started_at).
    `day` Date,
    `github_workflow_job_id` Int64,
    -- ci.tests.repo of the job's tests.
    `repo` LowCardinality(String),
    -- The job's environment, one per job: ci.environments.id.
    `environments_id` UInt64,
    -- env_vars['TEST_CONFIG'], one per job (other env vars vary by file).
    `test_config` LowCardinality(String),
    -- Raw test seconds per owner: every executed attempt, skips excluded, as
    -- ci.health's total duration; a file's seconds split evenly among its
    -- owners; '' for files without owners.
    `owner_test_seconds` Map(String, Float64),
    -- Occupancy: seconds of the job each owner's tests held the runner. Each
    -- report (one test process) spans its first test's start to its last
    -- test's end, clipped to the job; every instant is split evenly among the
    -- reports running then; a report's share goes to its owners by their test
    -- seconds in it. Sums to busy_seconds.
    `owner_held_seconds` Map(String, Float64),
    -- Seconds of the job with at least one report running.
    `busy_seconds` Float64,
    `reports` UInt32,
    `computed_at` DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (day, github_workflow_job_id)
;

-- Runner-hours by day, repository, workflow, test config, owner, machine and
-- runner label. Filled by cost_daily_mv (000005), which recomputes recent days many
-- times: repeated keys collapse to the latest computation, and since a
-- recomputation can drop keys, readers take each (repo, day)'s latest
-- computed_at.
CREATE TABLE cost_daily
(
    -- The day the jobs started (UTC).
    `day` Date,
    `repo` LowCardinality(String),
    -- lower(default.workflow_job.workflow_name).
    `workflow` LowCardinality(String),
    -- The job's TEST_CONFIG from its reports; empty for jobs without reports.
    `test_config` LowCardinality(String),
    -- An owner from ci.owners, or shared:build, shared:other,
    -- unattributed:no_test_reports, unattributed:no_owner.
    `owner` LowCardinality(String),
    -- The machine as ci.environments describes it; empty where unknown.
    `device_name` LowCardinality(String),
    `device_count` UInt8,
    `accelerator` LowCardinality(String),
    `os` LowCardinality(String),
    `cpu_architecture` LowCardinality(String),
    `cpu_capability` LowCardinality(String),
    -- job: the job's own reports; label: the day's reporting jobs on its
    -- runner label; empty: unknown.
    `machine_source` LowCardinality(String),
    -- The job's runner labels, comma-joined.
    `label` LowCardinality(String),
    -- Job wall time split by occupancy (owner_held_seconds / busy), setup and
    -- overhead included; a job without owners is all one bucket.
    `runner_hours` Float64,
    -- The part of runner_hours from time with no test report running (setup,
    -- gaps between tests, teardown).
    `overhead_hours` Float64,
    -- Raw test time (owner_test_seconds / 3600).
    `test_hours` Float64,
    -- Job wall time split by raw test-time share instead: the original method,
    -- for comparison. Sums to the same total as runner_hours.
    `test_ratio_hours` Float64,
    `computed_at` DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (
    repo, day, workflow, test_config, owner, device_name, device_count,
    accelerator, os, cpu_architecture, cpu_capability, machine_source, label
)
;
