import { buildCommitRunsQuery } from "lib/api/tests/commit/query";
import { buildRunAttemptsQuery } from "lib/api/tests/test/runs/attempts-query";
import { buildRunsQuery } from "lib/api/tests/test/runs/query";
import {
  baseCursor,
  baseQuery,
  ENV_VARS_ID,
  ENVIRONMENT_ID,
  TEST_ID,
} from "./fixtures";

const group = {
  tests_id: TEST_ID,
  environments_id: ENVIRONMENT_ID,
  env_vars_id: ENV_VARS_ID,
  github_workflow_job_id: "-9223372036854775808",
};

describe("group selection and attempt retrieval", () => {
  test.each([false, true])(
    "deduplicates before grouping and requires the same execution to match combined filters (commit=%s)",
    (commit) => {
      const selected: typeof baseQuery = {
        ...baseQuery,
        outcome: ["failed"],
        rerun_number: [0],
        last_attempt_outcome: ["passed"],
      };
      const { sql } = commit
        ? buildCommitRunsQuery(
            {
              ...selected,
              sha: "0123456789abcdef0123456789abcdef01234567",
              repo: "pytorch/pytorch",
            },
            null
          )
        : buildRunsQuery(selected, null);
      expect(sql).toContain("FROM ci.runs AS run FINAL");
      expect(sql).toContain(
        "GROUP BY run.tests_id, run.environments_id, run.env_vars_id, run.github_workflow_job_id"
      );
      expect(sql).toContain(
        "HAVING countIf(run.rerun_number IN {rerun_number: Array(UInt16)} AND run.outcome IN {outcome: Array(String)}) > 0"
      );
      expect(sql).toContain(
        "AND argMax(run.outcome, (run.started_at, run.ended_at, toString(run.id))) IN {last_attempt_outcome: Array(String)}"
      );
      const aggregation = sql.slice(
        sql.indexOf("min(run.started_at)"),
        sql.indexOf("HAVING")
      );
      expect(aggregation).not.toContain("{outcome:");
      expect(aggregation).not.toContain("{rerun_number:");
      expect(aggregation).not.toContain("{last_attempt_outcome:");
      expect(sql.indexOf("HAVING")).toBeLessThan(
        sql.lastIndexOf("LIMIT {entries_limit: UInt64}")
      );
      expect(sql).not.toMatch(/\b(?:now|today)\s*\(|\bINTERVAL\b/);
    }
  );

  test.each([false, true])(
    "last-attempt filtering alone requires deduplicated execution values (commit=%s)",
    (commit) => {
      const query: typeof baseQuery = {
        ...baseQuery,
        last_attempt_outcome: ["passed", "skipped"],
      };
      const { sql, params } = commit
        ? buildCommitRunsQuery(
            {
              ...query,
              sha: "0123456789abcdef0123456789abcdef01234567",
              repo: "pytorch/pytorch",
            },
            null
          )
        : buildRunsQuery(query, null);
      expect(params.last_attempt_outcome).toEqual(["passed", "skipped"]);
      expect(sql).toContain("FROM ci.runs AS run FINAL");
      expect(sql).toContain(
        "HAVING argMax(run.outcome, (run.started_at, run.ended_at, toString(run.id))) IN {last_attempt_outcome: Array(String)}"
      );
      expect(sql.indexOf("{last_attempt_outcome:")).toBeGreaterThan(
        sql.indexOf("GROUP BY")
      );
      expect(sql.indexOf("{last_attempt_outcome:")).toBeLessThan(
        sql.lastIndexOf("LIMIT {entries_limit: UInt64}")
      );
      expect(sql).not.toContain("countIf(");
    }
  );

  test("uses first start, last end and the last chronological attempt's outcome and original counter for sorting", () => {
    const { sql } = buildRunsQuery(
      {
        ...baseQuery,
        sort: ["outcome", "-rerun_number", "started_at", "-ended_at"],
      },
      null
    );
    expect(sql).toContain("min(run.started_at) AS started_at");
    expect(sql).toContain("max(run.ended_at) AS ended_at");
    expect(sql).toContain(
      "argMax(run.outcome, (run.started_at, run.ended_at, toString(run.id))) AS outcome"
    );
    expect(sql).toContain(
      "argMax(run.rerun_number, (run.started_at, run.ended_at, toString(run.id))) AS rerun_number"
    );
    expect(sql).not.toContain("max(run.rerun_number)");
  });

  test("applies the cursor to grouped values and never adds report or execution identity to group ties", () => {
    const { sql, params } = buildRunsQuery(baseQuery, baseCursor);
    expect(params).toEqual({
      test_id: TEST_ID,
      entries_limit: 3,
      ...Object.fromEntries(
        baseCursor.position.values.map((value, index) => [
          `cursor_${index}`,
          value,
        ])
      ),
    });
    expect(sql.indexOf("cursor_0")).toBeGreaterThan(sql.indexOf("GROUP BY"));
    const order = sql.slice(sql.lastIndexOf("ORDER BY"));
    expect(order).toContain(
      "run.started_at DESC, run.environments_id ASC, run.env_vars_id ASC, run.github_workflow_job_id ASC"
    );
    expect(order).not.toMatch(/report_uuid|rerun_number|run\.id\b/);
  });

  test("fetches exactly selected raw groups across reports and original counters without limits or attempt filters", () => {
    const second = {
      ...group,
      tests_id: "9007199254740993",
      environments_id: "0",
      env_vars_id: "1",
      github_workflow_job_id: "9223372036854775807",
    };
    const { sql, params } = buildRunAttemptsQuery([group, second]);
    expect(params).toEqual(
      Object.fromEntries(
        [group, second].flatMap((value, index) =>
          Object.entries(value).map(([field, id]) => [
            `group_${index}_${field}`,
            id,
          ])
        )
      )
    );
    expect(sql).toContain("FROM ci.runs AS run FINAL");
    for (const [index, value] of [group, second].entries()) {
      for (const [field, id] of Object.entries(value)) {
        expect(sql).toContain(
          `{group_${index}_${field}: ${
            field === "github_workflow_job_id" ? "Int64" : "UInt64"
          }}`
        );
        if (id.length > 1) expect(sql).not.toContain(id);
      }
    }
    const where = sql.slice(sql.indexOf("WHERE"), sql.lastIndexOf("ORDER BY"));
    expect(where).not.toMatch(
      /outcome|report_uuid|rerun_number|started_at|ended_at/
    );
    expect(sql).not.toMatch(
      /\bLIMIT\b|cursor_|\b(?:now|today)\s*\(|\bINTERVAL\b/
    );
    expect(sql).toContain(
      "ORDER BY run.started_at ASC, run.ended_at ASC, toString(run.id) ASC"
    );
    expect(sql).toContain("optimize_move_to_prewhere_if_final = 0");
  });
});
