import { CI_DATABASE } from "lib/api/tests/database";
import { catalogLabelSql } from "lib/api/tests/options/options";

// The rollup that holds test jobs' runner time by day, workflow, test file,
// environment and runner labels, both attributions computed per job
// (clickhouse_db_schema/fortesting/000004-test-cost-table.sql). It lives in
// the sandbox until it moves to ci.
const TEST_COST = "fortesting.test_cost";

// A test environment's machine, named as the tests page names its device:
// the device the test process probed, or for a CPU-only environment, which
// probes none, its OS, architecture and CPU capability ("Linux x86_64
// avx512").
const MACHINE = `if(device_name != '', device_name,
      concat(${catalogLabelSql(
        "os",
        "os"
      )}, ' ', cpu_architecture, ' ', cpu_capability))`;

// The window's rows of test_cost, each day as last computed.
const LATEST = `latest AS (
    SELECT * FROM ${TEST_COST}
    WHERE repo = {repo: String}
      AND day >= toDate({start: DateTime64(3)}) AND day < toDate({end: DateTime64(3)})
      AND (day, computed_at) IN (
        SELECT day, max(computed_at) FROM ${TEST_COST}
        WHERE repo = {repo: String}
          AND day >= toDate({start: DateTime64(3)}) AND day < toDate({end: DateTime64(3)})
        GROUP BY day)
  )`;

// Each runner label's machine: the one its jobs' test reports recorded for
// most of their hours. It names the machine of test jobs without reports, an
// estimate; a label no reporting test job ran on has none.
const LABEL_MACHINES = `label_machines AS (
    SELECT arrayStringConcat(t.runner_labels, ',') AS label, argMax(m.machine, t.ms) AS machine
    FROM (
      SELECT runner_labels, environments_id, sum(occupancy_runner_milliseconds) AS ms
      FROM latest
      WHERE environments_id != 0
      GROUP BY runner_labels, environments_id
    ) AS t
    INNER JOIN env_machines AS m ON m.id = t.environments_id
    GROUP BY label
  )`;

// The runner-hours of the window's test jobs by owner (or bucket), workflow,
// machine and runner label, from test_cost: each file's share of its jobs'
// wall time by occupancy, split evenly among the file's owners (ci.owners,
// read now), or the bucket of hours no owner is given, by why. Build and
// other jobs are not test cost and are left out. A workflow is named by its
// file (.github/workflows/pull.yml is pull), as the presets name them. Each
// row says where its machine came from: the jobs' test reports
// (environment), their runner label (runner_label, an estimate), or nowhere
// (none). Rows of files without owners keep the file, for the page to list.
export function runnerHoursQuery(): string {
  return `
WITH
  ${LATEST},
  env_machines AS (
    SELECT id, ${MACHINE} AS machine FROM ${CI_DATABASE}.environments FINAL
  ),
  ${LABEL_MACHINES},
  test_rows AS (
    SELECT
      multiIf(t.test_file = '', 'unattributed:no_test_reports',
        empty(o.owners), 'unattributed:no_owner', '') AS bucket,
      if(bucket = '', o.owners, [bucket]) AS owner_list,
      replaceRegexpAll(t.workflow_path, '^.*/|[.]ya?ml$', '') AS workflow,
      if(t.environments_id = 0, lm.machine, m.machine) AS machine,
      multiIf(t.environments_id != 0, 'environment',
        lm.machine != '', 'runner_label', 'none') AS machine_source,
      arrayStringConcat(t.runner_labels, ',') AS label,
      if(bucket = 'unattributed:no_owner', t.test_file, '') AS file,
      t.occupancy_runner_milliseconds / 1000 AS seconds
    FROM latest AS t
    LEFT JOIN (
      SELECT file, owners FROM ${CI_DATABASE}.owners FINAL WHERE repo = {repo: String}
    ) AS o ON o.file = t.test_file
    LEFT JOIN env_machines AS m ON m.id = t.environments_id
    LEFT JOIN label_machines AS lm ON lm.label = arrayStringConcat(t.runner_labels, ',')
  )
SELECT owner, workflow, machine, machine_source, label, file,
  sum(seconds) / 3600 AS runner_hours
FROM (
  SELECT owner, workflow, machine, machine_source, label, file,
    seconds / length(owner_list) AS seconds
  FROM test_rows
  ARRAY JOIN owner_list AS owner
)
GROUP BY owner, workflow, machine, machine_source, label, file
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
