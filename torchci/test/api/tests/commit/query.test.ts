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
      last_attempt_outcome: ["passed"],
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
    // One by_job pass groups the commit's rows by job and test and counts the
    // keys holding a single row, which are one-attempt bundles.
    expect(stats.sql).toContain(
      `FROM ci.runs AS run\n        WHERE ${COMMIT_JOBS}\n        GROUP BY run.github_workflow_job_id, run.tests_id`
    );
    // An array scalar: a tuple scalar fails beyond 1,000,000 keys.
    expect(stats.sql).toContain(
      "SELECT [(\n        groupArrayIf(job_test, stored_rows > 1),"
    );
    expect(stats.sql).toContain("stored_once[1] + count() AS total");
    RUN_OUTCOMES.forEach((outcome, index) => {
      expect(stats.sql).toContain(
        `countIf(stored_rows = 1 AND outcome = '${outcome}')`
      );
      expect(stats.sql).toContain(
        `stored_once[${
          index + 2
        }] + countIf(final_outcome = '${outcome}') AS ${outcome}`
      );
    });
    expect(stats.sql.match(/countIf\(final_outcome = /g)).toHaveLength(9);
    // The other keys' rows are grouped into bundles, each counted once under
    // the outcome of its last executed attempt; a skip never overrides one.
    expect(stats.sql).toContain(
      "SELECT argMax(run.outcome, (run.outcome != 'skipped', run.started_at, run.ended_at, toString(run.id))) AS final_outcome"
    );
    expect(stats.sql).toContain(
      "GROUP BY run.tests_id, run.environments_id, run.env_vars_id, run.github_workflow_job_id\n)"
    );
    // Those rows come from by_job, pruned by key: the starts holding one
    // stored row directly, the starts holding more through FINAL.
    const MULTI_ROW = `${COMMIT_JOBS}\n            AND (run.github_workflow_job_id, run.tests_id) IN (SELECT arrayJoin(multi_row_keys))`;
    expect(stats.sql).toContain(
      `FROM ci.runs AS run\n        WHERE ${MULTI_ROW}\n        GROUP BY run.tests_id, run.started_at\n        HAVING count() = 1\n        UNION ALL`
    );
    expect(stats.sql).toContain(
      `FROM ci.runs AS run FINAL\n        PREWHERE (run.tests_id, run.started_at) IN (SELECT run.tests_id, run.started_at\n            FROM ci.runs AS run\n            WHERE ${MULTI_ROW}\n            GROUP BY run.tests_id, run.started_at\n            HAVING count() > 1)\n        WHERE ${MULTI_ROW}\n    ) AS run`
    );
    expect(stats.sql).not.toContain("AS shared_starts");
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

  // Versions of one run share its test start, so a by_job pass finds the
  // starts holding more than one stored row; only those are read with FINAL.
  const SHARED_STARTS = `SELECT run.tests_id, run.started_at
            FROM ci.runs AS run
            WHERE ${COMMIT_JOBS}
            GROUP BY run.tests_id, run.started_at
            HAVING count() > 1`;
  const GROUP_COLUMNS =
    "run.tests_id AS tests_id, run.environments_id AS environments_id, run.env_vars_id AS env_vars_id, run.github_workflow_job_id AS github_workflow_job_id";

  test("reads FINAL only at shared test starts when a filter or sort needs replacement resolution", () => {
    const { sql } = buildCommitRunsQuery(
      { ...query, outcome: ["failed"] },
      null
    );
    // Rows at other starts come straight from by_job, as the statistics do.
    expect(sql).toContain(
      `FROM ci.runs AS run\n        WHERE ${COMMIT_JOBS}\n            AND (run.tests_id, run.started_at) NOT IN (${SHARED_STARTS})\n        UNION ALL`
    );
    expect(sql).toContain(
      `FROM ci.runs AS run FINAL\n        PREWHERE (run.tests_id, run.started_at) IN (${SHARED_STARTS})\n        WHERE ${COMMIT_JOBS}\n    ) AS run`
    );
    // Both branches read the group keys plus only what the grouping uses.
    expect(
      sql.match(
        new RegExp(
          `SELECT ${GROUP_COLUMNS.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&"
          )}, run.started_at AS started_at, run.outcome AS outcome\n`,
          "g"
        )
      )
    ).toHaveLength(2);
    expect(sql).not.toContain("run.id AS id");
    expect(sql).not.toContain("run.ended_at AS ended_at");
    expect(sql).not.toContain("run.rerun_number AS rerun_number");
    // The classification is an inline set, not a WITH scalar: the old
    // analyzer copies WITH into nested subqueries and overflows the AST limit.
    expect(sql).not.toContain("AS shared_starts");
    expect(sql).toContain(
      "GROUP BY run.tests_id, run.environments_id, run.env_vars_id, run.github_workflow_job_id\n    HAVING countIf(run.outcome IN {outcome: Array(String)}) > 0\n) AS run"
    );
  });

  test("reads the chronology columns only when the last attempt matters", () => {
    const lastAttempt = buildCommitRunsQuery(
      { ...query, last_attempt_outcome: ["passed"] },
      null
    ).sql;
    expect(lastAttempt).toContain(
      `${GROUP_COLUMNS}, run.started_at AS started_at, run.ended_at AS ended_at, run.id AS id, run.outcome AS outcome\n`
    );
    expect(lastAttempt).not.toContain("run.rerun_number AS rerun_number");
    const rerunSort = buildCommitRunsQuery(
      { ...query, sort: ["-rerun_number", "-started_at"] },
      null
    ).sql;
    expect(rerunSort).toContain(
      `${GROUP_COLUMNS}, run.started_at AS started_at, run.ended_at AS ended_at, run.id AS id, run.rerun_number AS rerun_number\n`
    );
    expect(rerunSort).not.toContain("run.outcome AS outcome");
    const endedSort = buildCommitRunsQuery(
      { ...query, sort: ["-ended_at"] },
      null
    ).sql;
    expect(endedSort).toContain(`${GROUP_COLUMNS}, run.ended_at AS ended_at\n`);
    expect(endedSort).not.toContain("run.started_at AS started_at");
  });

  test("keeps the direct by_job read when nothing mutable is selected or ordered", () => {
    for (const selected of [
      query,
      { ...query, rerun_number: [0] },
      { ...query, sort: ["file", "-started_at"] },
    ]) {
      const { sql } = buildCommitRunsQuery(selected, null);
      expect(sql).not.toContain("UNION ALL");
      expect(sql).not.toContain("HAVING count() > 1");
      expect(sql).toContain(
        `FROM ci.runs AS run\n    WHERE ${COMMIT_JOBS}\n    GROUP BY`
      );
      expect(sql).not.toMatch(/runs AS run FINAL/);
    }
  });
});
