import {
  buildCommitRunsQuery,
  buildCommitRunsStatsQuery,
} from "lib/api/tests/commit/query";
import { CI_DATABASE } from "lib/api/tests/database";
import { runsIdentity } from "lib/api/tests/test/runs/cursor";
import { parseRunsListParams } from "lib/api/tests/test/runs/parameters";
import { buildRunsQuery, runSortKeys } from "lib/api/tests/test/runs/query";
import { ENV_VARS_ID, ENVIRONMENT_ID, STARTED_AT, TEST_ID } from "./fixtures";

const literal = "  ' OR 1=1 -- λ雪,😀  ";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const rawFilters = {
  file: [literal, "test/other.py"],
  suite: [""],
  case_name: [literal],
  declared_case_name: [literal],
  language: ["python"],
  owner: [literal],
  os: [literal],
  os_version: [literal],
  cpu_architecture: [literal],
  cpu_capability: [literal],
  python_version: [literal],
  cc_compiler: [literal],
  cc_compiler_version: [literal],
  accelerator: [literal],
  accelerator_version: [literal],
  device_name: [literal],
  device_count: ["0", "255"],
  environments_id: ["0", ENVIRONMENT_ID],
  env_vars_id: ["0", ENV_VARS_ID],
  workflow_path: [literal],
  rerun_number: ["0", "65535"],
  outcome: ["failed", "error"],
  search: literal,
  "env_vars[EMPTY]": [""],
  "env_vars[QUOTED]": [literal],
};

function selection(sort: string[]) {
  const result = parseRunsListParams({
    test_id: TEST_ID,
    ...rawFilters,
    sort: sort.join(","),
    limit: "1",
  });
  if (!result.success) throw result.error;
  const { cursor: _cursor, ...query } = result.data;
  return query;
}

describe.each(
  [["-started_at"], ["file", "-device_count", "workflow_path", "outcome"]].map(
    (sort) => ({ sort })
  )
)("shared filtered run query $sort", ({ sort }) => {
  test("binds the same literal values for both endpoints and filters before the page limit", () => {
    const query = selection(sort);
    const { test_id: _testId, ...shared } = query;
    const forTest = buildRunsQuery(query, null);
    const forCommit = buildCommitRunsQuery(
      { ...shared, sha: SHA, repo: "pytorch/pytorch" },
      null
    );
    const statsForCommit = buildCommitRunsStatsQuery({
      ...shared,
      sha: SHA,
      repo: "pytorch/pytorch",
    });
    const { test_id: _testParameter, ...testParams } = forTest.params;
    const { sha: _sha, repo: _repo, ...commitParams } = forCommit.params;
    expect(testParams).toEqual(commitParams);
    // Supplying every filter family still counts the whole commit. The stats
    // boundary only reads repository and SHA, even from a full page request.
    expect(statsForCommit).toEqual(
      buildCommitRunsStatsQuery({ sha: SHA, repo: "pytorch/pytorch" })
    );
    expect(statsForCommit.params).toEqual({
      sha: SHA,
      repo: "pytorch/pytorch",
    });
    expect(testParams).toMatchObject({
      entries_limit: 2,
      filter_file: query.file,
      filter_suite: [""],
      filter_owner: [literal],
      filter_device_count: [0, 255],
      environments_id: ["0", ENVIRONMENT_ID],
      env_vars_id: ["0", ENV_VARS_ID],
      rerun_number: [0, 65535],
      outcome: ["error", "failed"],
      workflow_path: [literal],
      search: literal,
      env_var_name_0: "EMPTY",
      env_var_values_0: [""],
      env_var_name_1: "QUOTED",
      env_var_values_1: [literal],
    });
    for (const result of [forTest, forCommit]) {
      const { sql } = result;
      expect(sql).not.toContain(literal);
      const pageLimit = sql.lastIndexOf("LIMIT {entries_limit: UInt64}");
      expect(pageLimit).toBeGreaterThan(0);
      for (const clause of [
        "hasAny(owner.owners, {filter_owner: Array(String)})",
        "test.file IN {filter_file: Array(String)}",
        "test.suite IN {filter_suite: Array(String)}",
        "test.case_name IN {filter_case_name: Array(String)}",
        "test.declared_case_name IN {filter_declared_case_name: Array(String)}",
        "test.language IN {filter_language: Array(String)}",
        "environment.device_count IN {filter_device_count: Array(UInt8)}",
        "run.rerun_number IN {rerun_number: Array(UInt16)}",
        "run.outcome IN {outcome: Array(String)}",
        "run_workflow.workflow_path IN {workflow_path: Array(String)}",
        "mapContains(env_var_set.env_vars, {env_var_name_0: String})",
        "env_var_set.env_vars[{env_var_name_0: String}] IN {env_var_values_0: Array(String)}",
        "mapContains(env_var_set.env_vars, {env_var_name_1: String})",
        "env_var_set.env_vars[{env_var_name_1: String}] IN {env_var_values_1: Array(String)}",
      ]) {
        expect(sql).toContain(clause);
        expect(sql.indexOf(clause)).toBeLessThan(pageLimit);
      }
      for (const field of [
        "os",
        "os_version",
        "cpu_architecture",
        "cpu_capability",
        "python_version",
        "cc_compiler",
        "cc_compiler_version",
        "accelerator",
        "accelerator_version",
        "device_name",
      ]) {
        expect(sql).toContain(
          `environment.${field} IN {filter_${field}: Array(String)}`
        );
      }
      expect(sql).toContain(
        "(test.file = {search: String} OR test.suite = {search: String} OR test.case_name = {search: String} OR test.declared_case_name = {search: String})"
      );
      // An absent catalog row must not satisfy a filter for an empty string
      // or zero after a LEFT JOIN fills unmatched columns with defaults.
      if (sort.includes("file")) {
        expect(sql).toContain("run_test.has_catalog = 1");
        expect(sql).toContain("run_environment.has_catalog = 1");
      } else {
        expect(sql).toMatch(/run\.tests_id IN \(\s*SELECT test\.id/);
        expect(sql).toMatch(
          /run\.environments_id IN \(\s*SELECT environment\.id/
        );
      }
      expect(sql).toContain(`FROM ${CI_DATABASE}.runs AS run FINAL`);
      expect(sql).toContain("optimize_move_to_prewhere_if_final = 0");
    }
    expect(forCommit.sql).toContain(
      "WHERE run.github_workflow_job_id IN (SELECT arrayJoin(matched_job_ids))"
    );

    expect(forTest.sql).toContain("WHERE test.id = {test_id: UInt64}");
    expect(forTest.sql).not.toContain("SELECT DISTINCT run.tests_id");
    // DISTINCT would read tests_id in sorting-key order instead of by_job.
    expect(forCommit.sql).toContain("SELECT run.tests_id\n");
    expect(forCommit.sql).not.toContain("DISTINCT");
  });
});

test("binds literal cursor strings and distinguishes an empty value from NULL", () => {
  const query = selection(["file", "owner", "device_count"]);
  const values: Record<string, string | null> = {
    file: literal,
    owner: "",
    device_count: null,
    environments_id: ENVIRONMENT_ID,
    env_vars_id: ENV_VARS_ID,
    started_at: String(Date.parse(STARTED_AT)),
    github_workflow_job_id: "-9223372036854775808",
    rerun_number: "65535",
  };
  const { sql, params } = buildRunsQuery(query, {
    version: 2,
    resource: "test-runs",
    query: runsIdentity(query),
    position: { values: runSortKeys(query).map(({ field }) => values[field]) },
  });
  expect(sql).not.toContain(literal);
  expect(params.cursor_0).toBe(literal);
  expect(params.cursor_1).toBe("");
  expect(params).not.toHaveProperty("cursor_2");
  expect(sql).toContain("{cursor_0: String}");
  expect(sql).toContain("run_test.owner = {cursor_1: String}");
  expect(sql).toContain(
    "isNull(if(run_environment.has_catalog = 1, run_environment.device_count, NULL))"
  );
});
