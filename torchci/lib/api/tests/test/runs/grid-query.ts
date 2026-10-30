import { CI_DATABASE } from "lib/api/tests/database";
import type { HealthWindow } from "lib/api/tests/parameters";
import { buildEnvVarFilters } from "lib/api/tests/shared-sql";
import type { RunsGridQuery } from "lib/api/tests/test/runs/parameters";
import {
  catalogFilters,
  FINAL_OUTCOME,
  RUN_CHRONOLOGY,
} from "lib/api/tests/test/runs/query";
import {
  WORKFLOW_JOB_ORDER_SQL,
  WORKFLOW_PATH_SQL,
  WORKFLOW_RUN_ORDER_SQL,
} from "lib/api/tests/test/runs/workflow-query";

// How far back each window reaches, in seconds. The health view's windows,
// measured from its refresh; here measured from the request.
export const WINDOW_SECONDS: Record<HealthWindow, number> = {
  "3h": 3 * 3600,
  "12h": 12 * 3600,
  "1d": 24 * 3600,
  "3d": 3 * 24 * 3600,
  "7d": 7 * 24 * 3600,
  "14d": 14 * 24 * 3600,
};

// The start of the window that ends now, in Unix milliseconds, as the query
// binds it (a timestamp travels as Int64 and is converted on the bound side,
// as the page cursors' do); null when the request set no window.
export function windowStart(
  window: HealthWindow | undefined,
  now: Date
): number | null {
  return window === undefined
    ? null
    : now.getTime() - WINDOW_SECONDS[window] * 1000;
}

// The code source a job's runs count for, over the `job` (workflow_job) and
// `workflow` (workflow_run) rows: the health view's rule in
// clickhouse_db_schema/ci/000002-health-materialized-view.sql, so that the
// grid's main is the health table's main. A push to a ciflow/* tag is a pull
// request's run, not main's; a rerun_disabled_tests job is neither, and so
// is anything else, a workflow_dispatch among them.
export const RAN_ON_SQL = `multiIf(
        job.name LIKE '%rerun_disabled_tests%', 'other',
        job.head_branch = 'main' AND workflow.event IN ('push', 'schedule'), 'main',
        workflow.event = 'pull_request'
            OR (workflow.event = 'push' AND startsWith(job.head_branch, 'ciflow/')), 'pull_request',
        'other'
    )`;

// The window's start as the query binds it, Unix milliseconds since the
// epoch, and the attempts that started at or after it, as every read that
// bounds the window spells them.
const SINCE = "fromUnixTimestamp64Milli({since: Int64}, 'UTC')";
const WINDOW_START = `run.started_at >= ${SINCE}`;
// How far before the window's start the chains are read from, so that a
// job whose first attempt started before the window is seen whole and
// left out whole: a job's attempts span hours at most, GitHub ending a job
// after six on its own runners and the repository's longest after ten, so
// a day before the window reaches every attempt of a job that has one in
// it, and the read keeps the table's partitions by day pruned to the
// window and the day before (read from the retention's start
// instead, the chains read lost that pruning and took half as long again).
export const CHAIN_REACH_MS = 24 * 3600 * 1000;
const CHAINS_START =
  "run.started_at >= fromUnixTimestamp64Milli({chains_since: Int64}, 'UTC')";

// One test's runs grouped by commit, calling workflow, configuration and
// job, one row per job's chain of attempts. The window, `since` in Unix
// milliseconds (none when null), holds the jobs whose first attempt of the
// test started at or after it, with every attempt of those jobs, as the
// health table assigns a run to its windows by its first attempt; a job
// that started before the window and was rerun within it is left out
// whole, and no chain is ever cut at the window's start (a cut chain read
// as a plain pass when its failed attempt fell outside). The
// jobs with an attempt in the window are found first, by the runs' primary
// key, and their metadata read; the chain read takes the test's attempts
// from a day before the window (CHAIN_REACH_MS), through FINAL so a
// replaced attempt counts once, the join to those jobs keeps theirs (a
// third read of the jobs' ids in the chain read cost more than it saved), and the jobs whose first attempt is older go in
// HAVING. The key-column filters go before FINAL, which keeps every version
// of each selected attempt, as the attempts read does. The handler
// folds the jobs of a cell (queryRunGrid in grid.ts): which of two shards
// decides, what a re-run recovers, what a pass took. The jobs' branch, name
// and URL and their workflow runs' trigger, path and commit come from the
// latest retained metadata rows, as the bundle pages read them
// (workflow-query.ts); a run whose job has no retained metadata row, or
// whose job has no workflow run with a commit, is left out, since it has
// no column to stand in.
export function buildRunGridQuery(query: RunsGridQuery, since: number | null) {
  const params: Record<string, unknown> = { test_id: query.test_id };
  // The test's attempts in the selected configurations, by key columns.
  const runFilters = ["run.tests_id = {test_id: UInt64}"];
  for (const field of ["environments_id", "env_vars_id"] as const) {
    if (query[field] !== undefined) {
      params[field] = query[field];
      runFilters.push(
        `run.${field} IN CAST({${field}: Array(String)}, 'Array(UInt64)')`
      );
    }
  }
  const testFilters = [
    ...catalogFilters(query, "test", "test", params),
    ...catalogFilters(query, "owner", "owner", params),
  ];
  if (testFilters.length) {
    runFilters.push(`run.tests_id IN (
        SELECT test.id
        FROM ${CI_DATABASE}.tests AS test FINAL${
      query.owner === undefined
        ? ""
        : `
        LEFT JOIN (
            SELECT repo, file, owners FROM ${CI_DATABASE}.owners FINAL
        ) AS owner ON owner.repo = test.repo AND owner.file = test.file`
    }
        WHERE test.id = {test_id: UInt64}
            AND ${testFilters.join("\n            AND ")}
    )`);
  }
  const environmentFilters = catalogFilters(
    query,
    "environment",
    "environment",
    params
  );
  if (environmentFilters.length) {
    runFilters.push(`run.environments_id IN (
        SELECT environment.id
        FROM ${CI_DATABASE}.environments AS environment FINAL
        WHERE ${environmentFilters.join(" AND ")}
    )`);
  }
  const envVarFilters = buildEnvVarFilters(query.env_vars, params);
  if (envVarFilters.length) {
    runFilters.push(`run.env_vars_id IN (
        SELECT id FROM ${CI_DATABASE}.env_vars AS env_var_set FINAL
        WHERE ${envVarFilters.join(" AND ")}
    )`);
  }
  const metadataFilters = ["workflow.head_sha != ''"];
  if (query.ran_on !== undefined) {
    params.ran_on = query.ran_on;
    metadataFilters.push(`${RAN_ON_SQL} IN {ran_on: Array(String)}`);
  }
  if (query.workflow_path !== undefined) {
    params.workflow_path = query.workflow_path;
    metadataFilters.push(
      `${WORKFLOW_PATH_SQL} IN {workflow_path: Array(String)}`
    );
  }
  // The jobs with an attempt in the window, read without FINAL: a superset
  // of ids is harmless, since a job outside the selection matches no
  // selected run. The `jobs` read keeps one row per id, so a group's job
  // has one URL and one name and any() is exact.
  if (since !== null) {
    params.since = since;
    params.chains_since = since - CHAIN_REACH_MS;
  }
  const windowFilters =
    since === null ? runFilters : [...runFilters, WINDOW_START];
  const jobIds = `
        SELECT DISTINCT run.github_workflow_job_id
        FROM ${CI_DATABASE}.runs AS run
        WHERE ${windowFilters.join("\n            AND ")}`;
  // The chains read: the test's attempts from a day before the window, of
  // which the join keeps the jobs with an attempt in it.
  const chainFilters =
    since === null ? runFilters : [...runFilters, CHAINS_START];
  return {
    params,
    sql: `
WITH jobs AS (
    SELECT id, run_id, html_url, name, head_branch
    FROM default.workflow_job FINAL
    WHERE id IN (${jobIds}
    )
    ORDER BY ${WORKFLOW_JOB_ORDER_SQL}
    LIMIT 1 BY id
), workflows AS (
    SELECT id, path, head_sha, event
    FROM default.workflow_run FINAL
    WHERE id IN (
        SELECT run_id FROM default.workflow_job
        WHERE id IN (${jobIds}
        )
    )
    ORDER BY ${WORKFLOW_RUN_ORDER_SQL}
    LIMIT 1 BY id
)
SELECT
    workflow.head_sha AS commit_sha,
    ${WORKFLOW_PATH_SQL} AS workflow_path,
    toString(run.environments_id) AS environments_id_string,
    toString(run.env_vars_id) AS env_vars_id_string,
    toString(run.github_workflow_job_id) AS job_id_string,
    any(job.html_url) AS job_url,
    any(job.name) AS job_name,
    min(run.started_at) AS started_at,
    ${FINAL_OUTCOME} AS outcome,
    arrayMap(attempt -> attempt.4, arraySort(groupArray((${RUN_CHRONOLOGY}, toString(run.outcome))))) AS attempt_outcomes,
    sumIf(greatest(0, dateDiff('millisecond', run.started_at, run.ended_at)), run.outcome != 'skipped') AS duration_milliseconds,
    sumIf(greatest(0, dateDiff('millisecond', run.started_at, run.ended_at)), run.outcome = 'passed') AS passed_duration_milliseconds
FROM (
    SELECT run.id, run.environments_id, run.env_vars_id, run.github_workflow_job_id,
        run.outcome, run.started_at, run.ended_at
    FROM ${CI_DATABASE}.runs AS run FINAL
    PREWHERE ${chainFilters.join("\n        AND ")}
) AS run
INNER JOIN jobs AS job ON job.id = run.github_workflow_job_id
INNER JOIN workflows AS workflow ON workflow.id = job.run_id
WHERE ${metadataFilters.join("\n    AND ")}
GROUP BY commit_sha, workflow_path, run.environments_id, run.env_vars_id, run.github_workflow_job_id${
      since === null
        ? ""
        : `
HAVING min(run.started_at) >= ${SINCE}`
    }
ORDER BY started_at, commit_sha, workflow_path, run.environments_id, run.env_vars_id, run.github_workflow_job_id
SETTINGS optimize_move_to_prewhere_if_final = 0
`,
  };
}
