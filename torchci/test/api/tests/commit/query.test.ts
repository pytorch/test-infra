import { CommitRunsCursor } from "lib/api/tests/commit/cursor";
import { CommitRunsListQuery } from "lib/api/tests/commit/parameters";
import {
  buildCommitRunsQuery,
  buildCommitRunsStatsQuery,
} from "lib/api/tests/commit/query";
import { RUN_SORT_FIELDS } from "lib/api/tests/test/runs/parameters";
import {
  ENV_VARS_ID,
  ENVIRONMENT_ID,
  RUN_OUTCOMES,
  SORT_CASES,
  STARTED_AT,
  TEST_ID,
} from "../test/runs/fixtures";

const COMMIT_JOBS =
  "run.github_workflow_job_id IN (SELECT arrayJoin(matched_job_ids))";
const query: CommitRunsListQuery = {
  sha: "0123456789abcdef0123456789abcdef01234567",
  repo: "pytorch/pytorch",
  sort: ["-started_at"],
  limit: 2,
};
const cursor: CommitRunsCursor = {
  version: 2,
  resource: "commit-runs",
  query: { sha: query.sha, repo: query.repo, sort: query.sort },
  position: {
    values: [
      String(Date.parse(STARTED_AT)),
      TEST_ID,
      ENVIRONMENT_ID,
      ENV_VARS_ID,
      "-9223372036854775808",
    ],
  },
};
describe("commit runs query", () => {
  test("counts every recorded outcome across the entire commit independently of filters, ordering and page size", () => {
    const selected: CommitRunsListQuery = {
      ...query,
      environments_id: [ENVIRONMENT_ID],
      env_vars_id: [ENV_VARS_ID],
      rerun_number: [0, 1],
      outcome: ["error", "failed"],
    };
    const stats = buildCommitRunsStatsQuery(selected);
    const reordered: CommitRunsListQuery = {
      ...selected,
      sort: RUN_SORT_FIELDS.map((field) => `-${field}`),
      limit: 100,
    };
    expect(stats).toEqual(buildCommitRunsStatsQuery(reordered));
    expect(stats).toEqual(
      buildCommitRunsStatsQuery({ sha: query.sha, repo: query.repo })
    );
    expect(stats.params).toEqual({
      sha: query.sha,
      repo: query.repo,
    });
    expect(stats.sql).toContain("repository.full_name = {repo: String}");
    expect(stats.sql).toContain("head_sha = {sha: String}");
    // One by_job pass classifies the commit's runs by test start and counts
    // the starts holding a single run.
    expect(stats.sql).toContain(
      `FROM ci.runs AS run\n        WHERE ${COMMIT_JOBS}\n        GROUP BY run.tests_id, run.started_at`
    );
    // An array scalar: a tuple scalar fails beyond 1,000,000 shared starts.
    expect(stats.sql).toContain(
      "SELECT [(\n        groupArrayIf(test_start, stored_runs > 1),"
    );
    expect(stats.sql).toContain("stored_once[1] + count() AS total");
    RUN_OUTCOMES.forEach((outcome, index) => {
      expect(stats.sql).toContain(
        `countIf(stored_runs = 1 AND outcome = '${outcome}')`
      );
      expect(stats.sql).toContain(
        `stored_once[${
          index + 2
        }] + countIf(run.outcome = '${outcome}') AS ${outcome}`
      );
    });
    expect(stats.sql.match(/countIf\(run\.outcome = /g)).toHaveLength(9);
    // The commit's runs at shared starts are counted after FINAL, which reads
    // only those tests' granules.
    expect(stats.sql).toContain(
      `FROM ci.runs AS run FINAL\n    PREWHERE (run.tests_id, run.started_at) IN (SELECT arrayJoin(shared_starts))\n    WHERE ${COMMIT_JOBS}\n`
    );
    expect(stats.sql).not.toMatch(
      /\b(?:JOIN|LIMIT|ORDER BY)\b|cursor_|toDate\(/
    );
    expect(stats.sql).toMatch(
      /\nSETTINGS optimize_move_to_prewhere_if_final = 0\n$/
    );
  });

  test("selects jobs through workflow commit and repository metadata", () => {
    const { sql, params } = buildCommitRunsQuery(query, null);
    expect(params).toEqual({
      sha: query.sha,
      repo: query.repo,
      entries_limit: 3,
    });
    expect(sql).toMatch(/FROM default\.workflow_job\s+WHERE run_id IN/);
    expect(sql).toContain("FROM default.workflow_run");
    expect(sql).toContain("FROM materialized_views.workflow_run_by_head_sha");
    expect(sql).toContain("head_sha = {sha: String}");
    expect(sql).toContain("repository.full_name = {repo: String}");
    expect(sql).toContain("run.github_workflow_job_id IN");
    expect(sql).not.toContain(query.sha);
    expect(sql).not.toContain(query.repo);
    expect(sql).not.toMatch(/run\.tests_id = \{test_id/);
    // Workflows can have multiple attempts and PR jobs can carry a merge SHA.
    // Selecting those jobs by workflow association preserves all attempts.
    expect(sql).not.toMatch(/(?:job|workflow_job)\.head_sha\s*=/);
    expect(sql).not.toMatch(/(?:run_attempt|rerun_number)\s*=\s*(?:0|1)\b/);
    expect(sql).not.toMatch(/\b(?:event|head_branch|conclusion)\s*(?:=|IN)/);
    expect(sql).not.toMatch(/\b(?:now|today)\s*\(|\bINTERVAL\b/);
  });

  test("binds filters and complete group cursor IDs without precision loss", () => {
    const filtered: CommitRunsListQuery = {
      ...query,
      environments_id: ["9007199254740993", ENVIRONMENT_ID],
      env_vars_id: ["9007199254740992", ENV_VARS_ID],
      outcome: ["error", "failed"],
    };
    const { sql, params } = buildCommitRunsQuery(filtered, cursor);
    expect(params).toEqual({
      sha: query.sha,
      repo: query.repo,
      entries_limit: 3,
      environments_id: filtered.environments_id,
      env_vars_id: filtered.env_vars_id,
      outcome: filtered.outcome,
      ...Object.fromEntries(
        cursor.position.values.map((value, index) => [`cursor_${index}`, value])
      ),
    });
    expect(sql).toMatch(/FROM \w+\.runs AS run FINAL/);
    expect(sql).toContain(
      "run.environments_id IN CAST({environments_id: Array(String)}, 'Array(UInt64)')"
    );
    expect(sql).toContain(
      "run.env_vars_id IN CAST({env_vars_id: Array(String)}, 'Array(UInt64)')"
    );
    expect(sql).toContain(
      "run.started_at < fromUnixTimestamp64Milli({cursor_0: Int64})"
    );
    expect(sql).toContain("run.tests_id > {cursor_1: UInt64}");
    expect(sql).toContain("run.github_workflow_job_id > {cursor_4: Int64}");
    expect(sql).not.toContain("cursor_5");
    expect(sql).toContain(
      "run.started_at = fromUnixTimestamp64Milli({cursor_0: Int64}) AND run.tests_id = {cursor_1: UInt64}"
    );
    for (const value of [
      query.sha,
      query.repo,
      ...filtered.environments_id!,
      ...filtered.env_vars_id!,
      ...filtered.outcome!,
      ...cursor.position.values,
    ])
      expect(sql).not.toContain(value);
  });

  test.each(SORT_CASES)(
    "orders groups with the complete cross-test tie breakers for $sort",
    ({ sort }) => {
      const { sql } = buildCommitRunsQuery({ ...query, sort }, null);
      const expected = [
        ...sort.map(
          (field) =>
            `run.${field.replace(/^-/, "")} ${
              field.startsWith("-") ? "DESC" : "ASC"
            }`
        ),
        ...[
          "tests_id",
          "environments_id",
          "env_vars_id",
          "github_workflow_job_id",
        ].map((field) => `run.${field} ASC`),
      ].join(", ");
      expect(sql).toContain(
        `ORDER BY ${expected}\nLIMIT {entries_limit: UInt64}`
      );
      expect(sql).not.toContain("LIMIT 1 BY");
    }
  );
});
