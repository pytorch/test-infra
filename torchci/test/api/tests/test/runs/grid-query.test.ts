import {
  buildRunGridQuery,
  CHAIN_REACH_MS,
  RAN_ON_SQL,
  WINDOW_SECONDS,
  windowStart,
} from "lib/api/tests/test/runs/grid-query";
import type { RunsGridQuery } from "lib/api/tests/test/runs/parameters";
import { TEST_ID } from "./fixtures";

const base: RunsGridQuery = { test_id: TEST_ID, group_by: "commit" };
const SINCE = Date.parse("2026-10-21T18:00:00.000Z");

describe("buildRunGridQuery", () => {
  test("reads the test's runs by primary key before FINAL and groups by commit, workflow, configuration and job", () => {
    const { sql, params } = buildRunGridQuery(base, null);
    expect(params).toEqual({ test_id: TEST_ID });
    expect(sql).toContain(
      "FROM ci.runs AS run FINAL\n    PREWHERE run.tests_id = {test_id: UInt64}"
    );
    expect(sql).toContain(
      "GROUP BY commit_sha, workflow_path, run.environments_id, run.env_vars_id, run.github_workflow_job_id"
    );
    // One row per job's chain, with the job's own metadata: the jobs read
    // keeps one row per id, so any() is exact.
    expect(sql).toContain(
      "toString(run.github_workflow_job_id) AS job_id_string,\n    any(job.html_url) AS job_url,\n    any(job.name) AS job_name"
    );
    expect(sql).toContain(
      "INNER JOIN jobs AS job ON job.id = run.github_workflow_job_id"
    );
    expect(sql).toContain(
      "INNER JOIN workflows AS workflow ON workflow.id = job.run_id"
    );
    expect(sql).toContain("WHERE workflow.head_sha != ''");
    // The metadata comes from the latest retained rows, as the bundles' does.
    expect(sql).toContain("FROM default.workflow_job FINAL");
    expect(sql).toContain(
      "ORDER BY _inserted_at DESC, run_id DESC, dynamoKey DESC\n    LIMIT 1 BY id"
    );
    expect(sql).toContain("FROM default.workflow_run FINAL");
    expect(sql).toContain(
      "ORDER BY _inserted_at DESC, run_attempt DESC, dynamoKey DESC\n    LIMIT 1 BY id"
    );
    // A job's chain settles on its last executed attempt, as the statistics
    // do; the cell's outcome is the handler's to fold from its jobs.
    expect(sql).toContain(
      "argMax(run.outcome, (run.outcome != 'skipped', run.started_at, run.ended_at, toString(run.id))) AS outcome"
    );
    expect(sql).not.toContain("uniqExact");
    expect(sql).not.toContain("argMax(job.");
    expect(sql).toContain(
      "sumIf(greatest(0, dateDiff('millisecond', run.started_at, run.ended_at)), run.outcome != 'skipped') AS duration_milliseconds"
    );
    expect(sql).toContain(
      "sumIf(greatest(0, dateDiff('millisecond', run.started_at, run.ended_at)), run.outcome = 'passed') AS passed_duration_milliseconds"
    );
    expect(sql).not.toContain("{since:");
    expect(sql).not.toContain("{chains_since:");
    expect(sql).not.toContain("HAVING");
    // Without a window every attempt is read: nothing narrows the chains.
    expect(sql).toContain(
      "PREWHERE run.tests_id = {test_id: UInt64}\n) AS run"
    );
    expect(sql).not.toContain("{ran_on:");
    // Nothing in the statement depends on the clock: the window start is bound.
    expect(sql).not.toMatch(/\b(?:now|now64|today)\s*\(|\bINTERVAL\b/);
    expect(sql).toContain("SETTINGS optimize_move_to_prewhere_if_final = 0");
  });

  test("holds the jobs whose first attempt started in the window, with every attempt of theirs", () => {
    const { sql, params } = buildRunGridQuery(base, SINCE);
    expect(params.since).toBe(SINCE);
    // The chains are read from a day before the window, far enough back for
    // every attempt of a job that has one in it.
    expect(CHAIN_REACH_MS).toBe(24 * 3600 * 1000);
    expect(params.chains_since).toBe(SINCE - CHAIN_REACH_MS);
    expect(sql).toContain(
      "PREWHERE run.tests_id = {test_id: UInt64}\n        AND run.started_at >= fromUnixTimestamp64Milli({chains_since: Int64}, 'UTC')\n) AS run"
    );
    // The jobs with an attempt in the window are found by primary key, without
    // FINAL, for the two metadata reads; the inner join to them keeps their
    // chains.
    expect(
      sql.match(
        /SELECT DISTINCT run\.github_workflow_job_id\n\s+FROM ci\.runs AS run\n\s+WHERE run\.tests_id = \{test_id: UInt64\}\n\s+AND run\.started_at >= fromUnixTimestamp64Milli\(\{since: Int64\}, 'UTC'\)/g
      )
    ).toHaveLength(2);
    // A job whose first attempt started before the window is left out whole,
    // as the health table leaves it out of the window: no chain is cut.
    expect(sql).toContain(
      "HAVING min(run.started_at) >= fromUnixTimestamp64Milli({since: Int64}, 'UTC')\nORDER BY started_at"
    );
    // Nothing else bounds the attempts: a job's rerun after the window's
    // start is read with its first attempt.
    expect(
      sql.split("fromUnixTimestamp64Milli({since: Int64}, 'UTC')")
    ).toHaveLength(4);
  });

  test("classifies code sources as the health view does and filters on them after the joins", () => {
    const { sql, params } = buildRunGridQuery(
      { ...base, ran_on: ["main"] },
      null
    );
    expect(params.ran_on).toEqual(["main"]);
    expect(RAN_ON_SQL).toContain(
      "job.name LIKE '%rerun_disabled_tests%', 'other'"
    );
    expect(RAN_ON_SQL).toContain(
      "job.head_branch = 'main' AND workflow.event IN ('push', 'schedule'), 'main'"
    );
    expect(RAN_ON_SQL).toContain(
      "workflow.event = 'pull_request'\n            OR (workflow.event = 'push' AND startsWith(job.head_branch, 'ciflow/')), 'pull_request'"
    );
    expect(sql).toContain(
      `WHERE workflow.head_sha != ''\n    AND ${RAN_ON_SQL} IN {ran_on: Array(String)}`
    );
  });

  test("selects lanes by workflow path and by the configuration catalogs", () => {
    const { sql, params } = buildRunGridQuery(
      {
        ...base,
        workflow_path: [".github/workflows/pull.yml"],
        python_version: ["3.11"],
        env_vars: { TEST_CONFIG: ["default"] },
        environments_id: ["7"],
        owner: ["nn"],
      },
      null
    );
    expect(params.workflow_path).toEqual([".github/workflows/pull.yml"]);
    expect(sql).toContain(
      "AND nullIf(workflow.path, '') IN {workflow_path: Array(String)}"
    );
    expect(params.filter_python_version).toEqual(["3.11"]);
    expect(sql).toContain(
      "run.environments_id IN (\n        SELECT environment.id\n        FROM ci.environments AS environment FINAL\n        WHERE environment.python_version IN {filter_python_version: Array(String)}"
    );
    expect(params.env_var_name_0).toBe("TEST_CONFIG");
    expect(params.env_var_values_0).toEqual(["default"]);
    expect(sql).toContain(
      "run.env_vars_id IN (\n        SELECT id FROM ci.env_vars AS env_var_set FINAL"
    );
    expect(params.environments_id).toEqual(["7"]);
    expect(sql).toContain(
      "run.environments_id IN CAST({environments_id: Array(String)}, 'Array(UInt64)')"
    );
    expect(params.filter_owner).toEqual(["nn"]);
    expect(sql).toContain(
      "LEFT JOIN (\n            SELECT repo, file, owners FROM ci.owners FINAL"
    );
    expect(sql).toContain(
      "WHERE test.id = {test_id: UInt64}\n            AND hasAny(owner.owners, {filter_owner: Array(String)})"
    );
  });
});

describe("windowStart", () => {
  const now = new Date("2026-10-28T18:00:00.000Z");

  test("is null without a window", () => {
    expect(windowStart(undefined, now)).toBeNull();
  });

  test.each(Object.entries(WINDOW_SECONDS))(
    "reaches %s back from now",
    (window, seconds) => {
      expect(windowStart(window as keyof typeof WINDOW_SECONDS, now)).toBe(
        now.getTime() - seconds * 1000
      );
    }
  );

  test("knows every health window", () => {
    expect(Object.keys(WINDOW_SECONDS).sort()).toEqual(
      ["3h", "12h", "1d", "3d", "7d", "14d"].sort()
    );
    expect(WINDOW_SECONDS["7d"]).toBe(7 * 24 * 3600);
  });
});
