import type { TrendRollup } from "lib/api/tests/cost/windows";
import { CI_DATABASE } from "lib/api/tests/database";
import { catalogLabelSql } from "lib/api/tests/options/options";

// The rollup that holds test jobs' runner time by day, workflow, test file,
// environment, runner labels and trigger, both attributions computed per job
// (clickhouse_db_schema/ci/000004-test-cost-table.sql). Every query here but
// the changes' trigger breakdown sums the two triggers together.
export const TEST_COST = `${CI_DATABASE}.test_cost`;

// A test environment's machine, named as the tests page names its device:
// the device the test process probed, or for a CPU-only environment, which
// probes none, its OS, architecture and CPU capability ("Linux x86_64
// avx512").
const MACHINE = `if(device_name != '', device_name,
      concat(${catalogLabelSql(
        "os",
        "os"
      )}, ' ', cpu_architecture, ' ', cpu_capability))`;

// The window's rows of test_cost, each day as last computed, in one read.
const LATEST = `latest AS (
    SELECT * EXCEPT latest_computed_at
    FROM (
      SELECT *, max(computed_at) OVER (PARTITION BY day) AS latest_computed_at
      FROM ${TEST_COST}
      WHERE repo = {repo: String}
        AND day >= toDate({start: DateTime64(3)}) AND day < toDate({end: DateTime64(3)})
    )
    WHERE computed_at = latest_computed_at
  )`;

// Each runner label's machine: the one its jobs' test reports recorded for
// most of their hours, summed by machine (a machine spans many environments:
// python, compiler and accelerator versions). It names the machine of test
// jobs without reports, an estimate; a label no reporting test job ran on has
// none.
const LABEL_MACHINES = `label_machines AS (
    SELECT label, argMax(machine, ms) AS machine
    FROM (
      SELECT arrayStringConcat(t.runner_labels, ',') AS label, m.machine AS machine,
        sum(t.occupancy_runner_milliseconds) AS ms
      FROM latest AS t
      INNER JOIN env_machines AS m ON m.id = t.environments_id
      GROUP BY label, machine
    )
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
      if(m.machine != '', m.machine, lm.machine) AS machine,
      multiIf(m.machine != '', 'environment',
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

// How many of the window's days test_cost holds for the repository, and the
// first of them: what a daily average divides by, and where the data starts.
export function coverageQuery(): string {
  return `
SELECT uniqExact(day) AS days, toString(min(day)) AS first_day
FROM ${TEST_COST}
WHERE repo = {repo: String}
  AND day >= toDate({start: DateTime64(3)}) AND day < toDate({end: DateTime64(3)})`;
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

// The rows of test_cost on some days as each day was last computed, picked
// by (day, computed_at) rather than a window over every row: over a year of
// days the window function costs ten times the whole trend query
// (query-validation.md).
function latestDayRows(days: string): string {
  return `(day, computed_at) IN (
    SELECT day, max(computed_at) FROM ${TEST_COST}
    WHERE repo = {repo: String}
      AND ${days}
    GROUP BY day
  )`;
}

const IN_WINDOW = `day >= toDate({start: DateTime64(3)}) AND day < toDate({end: DateTime64(3)})`;
const LATEST_DAY_ROWS = latestDayRows(IN_WINDOW);

// How long after a day begins its computation counts it whole: a day
// computed at 00:30 the next day lacked 2-5% of its test jobs' hours (jobs
// still running), at 03:30 0.1-0.2%, at 06:30 0.03%
// (query-validation.md). The view recomputes every 3 hours from 00:30, so a
// day is whole from the 03:30 computation after it.
export const FILLING_HOURS = 27;

// The runner time of pushes to main among a group's rows: what cost per
// commit divides by the pushes.
const MAIN_MS = `sumIf(occupancy_runner_milliseconds, trigger = 'push:main') AS main_ms`;

// A workflow by its file, as the runner-hours name it: pull for
// .github/workflows/pull.yml.
const WORKFLOW = `replaceRegexpAll(workflow_path, '^.*/|[.]ya?ml$', '')`;

// Rows of the scope: every workflow when none is asked for, workflows named
// by their file, lowercase, as the runner-hours name them.
const IN_SCOPE = `(empty({workflows: Array(String)})
      OR lower(${WORKFLOW}) IN {workflows: Array(String)})`;

// Each cell's owners, joined on its test file (ci.owners, read now), or the
// bucket of hours no owner is given, as owner_list.
const WITH_OWNERS = `SELECT c.*,
      multiIf(c.test_file = '', ['unattributed:no_test_reports'],
        empty(o.owners), ['unattributed:no_owner'], o.owners) AS owner_list
    FROM cells AS c
    LEFT JOIN (
      SELECT file, owners FROM ${CI_DATABASE}.owners FINAL WHERE repo = {repo: String}
    ) AS o ON o.file = c.test_file`;

const PERIOD_START: Record<TrendRollup, string> = {
  day: "day",
  week: "toMonday(day)",
  month: "toStartOfMonth(day)",
};

// The trend's runner-hours by period, owner and runner label, all of them
// and those of pushes to main (the trigger push:main), for cost per commit:
// summed by period, test file and label first, so the owners join and split
// a row per file and label rather than per environment and workflow, which
// over a year is about a tenth of the work, then split evenly among each
// file's owners (ci.owners, read now) as the runner-hours are, or the bucket
// of hours no owner is given. Rounded to 0.0001 h, a third of a second.
export function trendQuery(rollup: TrendRollup): string {
  return `
WITH
  cells AS (
    SELECT toString(${PERIOD_START[rollup]}) AS period, test_file,
      arrayStringConcat(runner_labels, ',') AS label,
      sum(occupancy_runner_milliseconds) AS ms,
      ${MAIN_MS}
    FROM ${TEST_COST}
    WHERE repo = {repo: String}
      AND ${IN_WINDOW}
      AND ${IN_SCOPE}
      AND ${LATEST_DAY_ROWS}
    GROUP BY period, test_file, label
  )
SELECT period, owner, label,
  round(sum(ms / length(owner_list)) / 3600000, 4) AS runner_hours,
  round(sum(main_ms / length(owner_list)) / 3600000, 4) AS main_runner_hours
FROM (
  ${WITH_OWNERS}
)
ARRAY JOIN owner_list AS owner
GROUP BY period, owner, label
SETTINGS join_use_nulls = 0`;
}

// Each day's runner-hours by runner label, for the year to date and the days
// each period has data: no owners, so no join, since splitting among owners
// keeps a day's sum. Rows outside the scope fold into one row a day with
// label '' and 0 h, so a day with data is one the rollup holds, as
// coverageQuery counts them, not one the scope's workflows ran. A day is
// filling while its latest computation began less than FILLING_HOURS after
// the day began: jobs that started on it are still finishing. The day is
// spelled day_utc: an alias named day would stand for the column in WHERE.
export function trendDailyQuery(): string {
  return `
SELECT toString(day) AS day_utc,
  if(${IN_SCOPE}, arrayStringConcat(runner_labels, ','), '') AS label,
  round(sumIf(occupancy_runner_milliseconds, ${IN_SCOPE}) / 3600000, 4) AS runner_hours,
  round(sumIf(occupancy_runner_milliseconds,
    ${IN_SCOPE} AND trigger = 'push:main') / 3600000, 4) AS main_runner_hours,
  max(computed_at) < addHours(toDateTime(min(day), 'UTC'), ${FILLING_HOURS}) AS filling
FROM ${TEST_COST}
WHERE repo = {repo: String}
  AND ${IN_WINDOW}
  AND ${LATEST_DAY_ROWS}
GROUP BY day_utc, label`;
}

// The days of two periods compared, A and B, both ends included.
const IN_SIDES = `(day BETWEEN {a_from: Date} AND {a_to: Date}
      OR day BETWEEN {b_from: Date} AND {b_to: Date})`;

// The period or periods a day counts in, as side: 0 for A, 1 for B, both
// for a day in both.
const SIDES = `arrayJoin(arrayFilter(s -> s >= 0, [
    if(day BETWEEN {a_from: Date} AND {a_to: Date}, 0, -1),
    if(day BETWEEN {b_from: Date} AND {b_to: Date}, 1, -1)])) AS side`;

// What changed between two periods, A (side 0) and B (side 1): the
// runner-hours of each by runner label, all of them and those of pushes to
// main, for the page to price, to sum by machine and to divide by the days
// or the pushes. For some owners, each test file's hours are their share as
// the trend splits them (a file's evenly among its owners, or a bucket's),
// so the cells are summed by file before the owners join; for every owner
// there is no join.
export function changesQuery(forOwners: boolean): string {
  const where = `WHERE repo = {repo: String}
  AND ${IN_SIDES}
  AND ${IN_SCOPE}
  AND ${latestDayRows(IN_SIDES)}`;
  if (!forOwners) {
    return `
SELECT
  ${SIDES},
  arrayStringConcat(runner_labels, ',') AS label,
  round(sum(occupancy_runner_milliseconds) / 3600000, 4) AS runner_hours,
  round(sumIf(occupancy_runner_milliseconds, trigger = 'push:main') / 3600000, 4) AS main_runner_hours
FROM ${TEST_COST}
${where}
GROUP BY side, label
HAVING runner_hours > 0`;
  }
  return `
WITH
  cells AS (
    SELECT
      ${SIDES.replace(/\n/g, "\n    ")},
      test_file, arrayStringConcat(runner_labels, ',') AS label,
      sum(occupancy_runner_milliseconds) AS ms,
      ${MAIN_MS}
    FROM ${TEST_COST}
    ${where.replace(/\n/g, "\n    ")}
    GROUP BY side, test_file, label
  )
SELECT side, label,
  round(sum(ms * share) / 3600000, 4) AS runner_hours,
  round(sum(main_ms * share) / 3600000, 4) AS main_runner_hours
FROM (
  SELECT c.side AS side, c.label AS label, c.ms AS ms, c.main_ms AS main_ms,
    arrayCount(owner -> has({owners: Array(String)}, owner), owner_list)
      / length(owner_list) AS share
  FROM (
    ${WITH_OWNERS}
  ) AS c
)
GROUP BY side, label
HAVING runner_hours > 0
SETTINGS join_use_nulls = 0`;
}

// Pushes to main or master of the repository in default.push, read by
// subcolumns: the quoted form (head_commit.'timestamp') prunes by the sort
// key but reads every row's whole tuples, 2.8 GB for a year against 138 MB
// for the three subcolumns of every row (query-validation.md).
const MAIN_PUSHES = `repository.full_name = {repo: String}
    AND ref IN ('refs/heads/main', 'refs/heads/master')
    AND NOT deleted`;

// The days of A and B the rollup holds, what their per-day figures divide
// by, each with its pushes to main: distinct head commits pushed to main or
// master, by their timestamp's day, which for a merge is the day it landed.
// Each push runs CI on its head commit once, however many commits it lands.
export function changesDaysQuery(): string {
  return `
SELECT toString(d.day) AS day_utc, p.pushes AS pushes
FROM (
  SELECT DISTINCT day FROM ${TEST_COST}
  WHERE repo = {repo: String} AND ${IN_SIDES}
) AS d
LEFT JOIN (
  SELECT toDate(head_commit.timestamp) AS day,
    uniqExact(head_commit.id) AS pushes
  FROM default.push
  WHERE ${MAIN_PUSHES}
    AND (head_commit.timestamp >= {a_from: Date} AND head_commit.timestamp < {a_to: Date} + 1
      OR head_commit.timestamp >= {b_from: Date} AND head_commit.timestamp < {b_to: Date} + 1)
  GROUP BY day
) AS p ON p.day = d.day
SETTINGS join_use_nulls = 0`;
}

// Each day's pushes to main from start to end: distinct head commits pushed
// to main or master, by their timestamp's day, which for a merge is the day
// it landed; cost per commit divides push:main runner-hours by them.
export function trendPushesQuery(): string {
  return `
SELECT toString(toDate(head_commit.timestamp)) AS day_utc,
  uniqExact(head_commit.id) AS pushes
FROM default.push
WHERE ${MAIN_PUSHES}
  AND head_commit.timestamp >= {start: DateTime64(3)}
  AND head_commit.timestamp < {end: DateTime64(3)}
GROUP BY day_utc`;
}
