import { CI_DATABASE } from "lib/api/tests/database";
import { catalogLabelSql } from "lib/api/tests/options/options";

// Runner-hours are job wall time, started_at to completed_at, of every
// completed, not skipped job of the repository that started in the window
// on a runner. started_at has a minmax index, so the window prunes granules.
// Three kinds of rows never ran and are left out: a job cancelled before a
// runner took it has no runner, and its time is queue time; a rerun carries
// forward the jobs it did not repeat with their original started_at, before
// the rerun's created_at; and GitHub closes a job that never started 30 days
// later, which the 24 hour cap removes (no real job runs that long). Over
// 2026-10-23 to 10-29 these hours matched OSDC's own count of running jobs
// to about 1%.
const COMPLETED_JOBS = `repository_full_name = {repo: String}
    AND status = 'completed'
    AND conclusion NOT IN ('skipped', '')
    AND runner_name != ''
    AND started_at >= {start: DateTime64(3)}
    AND started_at < {end: DateTime64(3)}
    AND started_at >= created_at
    AND dateDiff('second', started_at, completed_at) BETWEEN 0 AND 86400`;

const JOB_SECONDS = "dateDiff('second', started_at, completed_at)";

// The job's runner labels as one value; a job almost always asks for one.
const LABEL = "arrayStringConcat(labels, ',')";

// A test job's name ends in "test (<config>, <shard>, <shards>, <runner>)",
// possibly after a calling workflow's prefix ("dynamo-test (3.12) / test (...)").
const TEST_JOB = String.raw`'(?:^|/ )test \\('`;
const TEST_CONFIG = String.raw`extract(name, '(?:^|/ )test \\(([^,]+),')`;
const JOB_KIND_SQL = `multiIf(
      match(name, ${TEST_JOB}), 'test',
      positionCaseInsensitive(name, 'build') > 0, 'build',
      'other')`;

// A test environment's machine, named as the tests page names its device:
// the device the test process probed, or for a CPU-only environment, which
// probes none, its OS, architecture and CPU capability ("Linux x86_64
// avx512").
const MACHINE = `if(device_name != '', device_name,
      concat(${catalogLabelSql(
        "os",
        "os"
      )}, ' ', cpu_architecture, ' ', cpu_capability))`;

// How many test jobs per runner label the machine map samples.
export const MACHINE_SAMPLE_PER_LABEL = 20;

// Each runner label's machine, from a sample of the window's test jobs on it:
// up to MACHINE_SAMPLE_PER_LABEL of them, chosen by a hash of the job id, are
// looked up in ci.runs (by_job projection) for the environment their tests
// recorded, and the label takes the machine most of them ran on. A label
// none of whose sampled jobs recorded tests (builds, benchmarks, runners whose
// reports do not reach ci) has no row, so its jobs come out with machine ''.
// Test rows are read to a day past the window, since a job that starts at its
// end runs on. This is the prototype's approximation: one machine per label.
const LABEL_MACHINES = `label_machines AS (
    SELECT label, argMax(machine, jobs) AS machine
    FROM (
      SELECT s.label AS label, m.machine AS machine, count() AS jobs
      FROM (
        SELECT github_workflow_job_id AS job_id, any(environments_id) AS environments_id
        FROM ${CI_DATABASE}.runs
        WHERE github_workflow_job_id IN (SELECT id FROM machine_sample)
          AND started_at >= {start: DateTime64(3)}
          AND started_at < {end: DateTime64(3)} + INTERVAL 1 DAY
        GROUP BY job_id
      ) AS r
      INNER JOIN machine_sample AS s ON s.id = r.job_id
      INNER JOIN (
        SELECT id, ${MACHINE} AS machine FROM ${CI_DATABASE}.environments FINAL
      ) AS m ON m.id = r.environments_id
      GROUP BY label, machine
    )
    GROUP BY label
  )`;
// The sample keeps each label's smallest hashes as it reads (groupArraySorted)
// rather than sorting the window's test jobs, which picks the same jobs with
// less CPU and half the memory (lib/api/tests/cost/query-validation.md).
const MACHINE_SAMPLE = `machine_sample AS (
    SELECT tupleElement(sampled, 2) AS id, label
    FROM (
      SELECT ${LABEL} AS label,
        groupArraySorted(${MACHINE_SAMPLE_PER_LABEL})((cityHash64(id), id)) AS sample
      FROM default.workflow_job
      WHERE ${COMPLETED_JOBS} AND match(name, ${TEST_JOB})
      GROUP BY label
    )
    ARRAY JOIN sample AS sampled
  )`;

// Each owner's share of a test config's test time on a machine. A test job's
// hours go to owners in proportion to each owner's share of the test time
// recorded for the job's test config on the job's machine in ci.health's
// window of the same length: the total duration of every attempt, summed by
// file, the file's owners from ci.owners (split evenly when a file has
// several). Shares are taken per machine because test sets differ by machine:
// many tests only run on GPUs and are skipped on CPU jobs of the same config.
// A job whose machine is unknown takes its config's shares over every
// machine (the second grouping set, machine ''). Jobs whose config records no
// tests on their machine (benchmarks, XPU and s390x, whose reports do not
// arrive, configs without test reports) stay unattributed, as does the time
// of files without owners (C++ test binaries are named by binary and match
// no file); build and other jobs serve every owner and are returned as
// shared. ci.health windows end at its last refresh, at most 15 minutes ago,
// while the jobs' window ends at the start of today: the shares come from a
// window up to a day later than the hours.
const OWNER_SHARES = `owner_shares AS (
    SELECT test_config, machine, owner,
      seconds / sum(seconds) OVER (PARTITION BY test_config, machine) AS share
    FROM (
      SELECT s.test_config AS test_config, s.machine AS machine,
        arrayJoin(if(empty(o.owners), [''], o.owners)) AS owner,
        sum(s.seconds / greatest(length(o.owners), 1)) AS seconds
      FROM (
        SELECT e.test_config AS test_config, m.machine AS machine, t.file AS file,
          sum(h.total_duration_milliseconds) / 1000 AS seconds
        FROM ${CI_DATABASE}.health AS h
        INNER JOIN (
          SELECT id, env_vars['TEST_CONFIG'] AS test_config
          FROM ${CI_DATABASE}.env_vars FINAL
        ) AS e ON e.id = h.env_vars_id
        INNER JOIN (
          SELECT id, ${MACHINE} AS machine FROM ${CI_DATABASE}.environments FINAL
        ) AS m ON m.id = h.environments_id
        INNER JOIN (
          SELECT id, file FROM ${CI_DATABASE}.tests FINAL WHERE repo = {repo: String}
        ) AS t ON t.id = h.tests_id
        WHERE h.window = {window: String} AND e.test_config != ''
        GROUP BY test_config, machine, file
      ) AS s
      LEFT JOIN (
        SELECT file, owners FROM ${CI_DATABASE}.owners FINAL WHERE repo = {repo: String}
      ) AS o ON o.file = s.file
      GROUP BY GROUPING SETS ((test_config, machine, owner), (test_config, owner))
    )
  )`;

// The owner a share of a job's hours goes to, or the bucket of hours no
// owner is given, by why.
const OWNER_KEY = `multiIf(
    j.kind = 'build', 'shared:build',
    j.kind = 'other', 'shared:other',
    s.test_config = '', 'unattributed:no_test_reports',
    s.owner = '', 'unattributed:no_owner',
    s.owner)`;

// The runner-hours of the window by owner (or bucket), workflow and
// machine, so one answer serves every workflow scope, owner and machine. Every
// row keeps its runner label too, which the API folds into each machine's
// labels and the labels of hours on no known machine. Owner shares are per
// test config and machine over every workflow, so a single workflow's split
// among owners is approximate, while its total is exact.
export function runnerHoursQuery(): string {
  return `
WITH
  ${MACHINE_SAMPLE},
  ${LABEL_MACHINES},
  ${OWNER_SHARES},
  job_hours AS (
    SELECT j.kind AS kind, j.test_config AS test_config, j.workflow AS workflow,
      lm.machine AS machine, j.label AS label,
      sum(j.seconds) / 3600 AS runner_hours
    FROM (
      SELECT ${JOB_KIND_SQL} AS kind,
        if(kind = 'test', ${TEST_CONFIG}, '') AS test_config,
        lower(workflow_name) AS workflow,
        ${LABEL} AS label, ${JOB_SECONDS} AS seconds
      FROM default.workflow_job
      WHERE ${COMPLETED_JOBS}
    ) AS j
    LEFT JOIN label_machines AS lm ON lm.label = j.label
    GROUP BY kind, test_config, workflow, machine, label
  )
SELECT
  ${OWNER_KEY} AS owner,
  j.workflow AS workflow,
  j.machine AS machine,
  j.label AS label,
  sum(j.runner_hours * if(s.test_config = '', 1, s.share)) AS runner_hours
FROM job_hours AS j
LEFT JOIN owner_shares AS s ON s.test_config = j.test_config AND s.machine = j.machine
GROUP BY owner, workflow, machine, label
SETTINGS join_use_nulls = 0`;
}

// Each machine's family, from the columns of the environments that name it,
// so a new device, accelerator or OS needs no change here: a machine with a
// device belongs to its accelerator (CUDA, ROCm, XPU, MPS, or a new
// accelerator under its own name), one without to its OS's CPUs. Names use
// the catalog's labels (catalogLabelSql), as the tests page shows them. The
// API shortens device names from the devices present (runnerHours.ts); a CPU's
// short name is its architecture and capability. A machine is one name, so
// any environment's answer stands for all of them.
export function machinesQuery(): string {
  return String.raw`
SELECT
  ${MACHINE} AS machine,
  any(if(device_name != '',
    ${catalogLabelSql("accelerator", "accelerator")},
    concat(${catalogLabelSql("os", "os")}, ' CPU'))) AS family,
  any(device_name) AS device,
  any(concat(cpu_architecture, ' ', cpu_capability)) AS cpu
FROM ${CI_DATABASE}.environments FINAL
GROUP BY machine`;
}

// HUD's time to signal, as the metrics page computes it
// (clickhouse_queries/workflow_duration_percentile), on main only: for each
// workflow, the median and 90th percentile of the time from a run's creation
// to its last update, over successful first attempts created in the window,
// here pushes to main (as the page's "push to main only" table reads them).
// The runs are picked by creation time through the materialized view HUD's
// own TTS queries use, which reads the same rows four times faster than
// filtering workflow_run.
export function timeToSignalQuery(): string {
  return String.raw`
SELECT
  lower(name) AS workflow,
  count() AS runs,
  quantilesExact(0.5, 0.9)(dateDiff('second', created_at, updated_at)) AS seconds
FROM default.workflow_run FINAL
WHERE id IN (
    SELECT id FROM materialized_views.workflow_run_by_created_at
    WHERE created_at >= {start: DateTime64(3)} AND created_at < {end: DateTime64(3)}
  )
  AND repository.'full_name' = {repo: String}
  AND lower(name) IN {tts_workflows: Array(String)}
  AND created_at >= {start: DateTime64(3)}
  AND created_at < {end: DateTime64(3)}
  AND conclusion = 'success'
  AND run_attempt = 1
  AND head_branch = 'main'
  AND event = 'push'
GROUP BY workflow`;
}
