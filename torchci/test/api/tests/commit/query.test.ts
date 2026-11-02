import { CommitRunsCursor } from "lib/api/tests/commit/cursor";
import { CommitRunsListQuery } from "lib/api/tests/commit/parameters";
import { buildCommitRunsQuery } from "lib/api/tests/commit/query";
import {
  ENV_VARS_ID,
  ENVIRONMENT_ID,
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
      candidate_outcomes: filtered.outcome,
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
    // A filter on a common outcome: most of the commit's rows hold one, so
    // no key set could prune the read.
    const { sql } = buildCommitRunsQuery(
      { ...query, outcome: ["passed"] },
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

  test("reads FINAL by the tests holding a rare outcome when the attempt filters admit only those", () => {
    const CANDIDATE_TESTS = `PREWHERE run.tests_id IN (SELECT run.tests_id
        FROM ci.runs AS run
        WHERE ${COMMIT_JOBS}
            AND run.outcome IN {candidate_outcomes: Array(String)}
        GROUP BY run.tests_id)
    WHERE ${COMMIT_JOBS}`;
    for (const [selected, candidates] of [
      [{ outcome: ["failed"] }, ["failed"]],
      [
        { outcome: ["crashed", "error", "timed_out"] },
        ["crashed", "error", "timed_out"],
      ],
      [{ last_attempt_outcome: ["timed_out"] }, ["timed_out"]],
      // The outcome filter's values come first; the last attempt's would
      // prune nothing here.
      [{ outcome: ["xpassed"], last_attempt_outcome: ["passed"] }, ["xpassed"]],
      [{ outcome: ["passed"], last_attempt_outcome: ["error"] }, ["error"]],
      [
        { status: ["failed", "timed_out", "flaky"] },
        ["crashed", "error", "failed", "timed_out"],
      ],
      [{ status: ["other"] }, ["unknown", "xpassed"]],
      // A test whose worst status is failed has a failed bundle.
      [{ worst_status: ["failed"] }, ["crashed", "error", "failed"]],
      [{ status: ["other"], worst_status: ["other"] }, ["unknown", "xpassed"]],
    ] as const) {
      const { sql, params } = buildCommitRunsQuery(
        { ...query, ...selected } as unknown as CommitRunsListQuery,
        null
      );
      expect({ selected, candidates: params.candidate_outcomes }).toEqual({
        selected,
        candidates,
      });
      expect(sql).toContain(
        `FROM ci.runs AS run FINAL\n    ${CANDIDATE_TESTS}`
      );
      expect(sql).not.toContain("UNION ALL");
      expect(sql).not.toContain("HAVING count() > 1");
    }
    // A common outcome among the admitted ones leaves the shared-start read;
    // so does an expected failure, rare among rows but held by thousands of
    // tests, each read whole from every part (query-validation.md).
    for (const selected of [
      { outcome: ["passed"] },
      { last_attempt_outcome: ["skipped"] },
      { status: ["flaky", "passed"] },
      { status: ["passed"], worst_status: ["passed"] },
      { outcome: ["passed", "failed"] },
      { outcome: ["xfailed"] },
      { outcome: ["xfailed"], last_attempt_outcome: ["passed"] },
      { status: ["xfailed"] },
      { status: ["xfailed"], worst_status: ["xfailed"] },
      { sort: ["-ended_at"] },
    ] as const) {
      const { sql, params } = buildCommitRunsQuery(
        { ...query, ...selected } as unknown as CommitRunsListQuery,
        null
      );
      expect(params).not.toHaveProperty("candidate_outcomes");
      expect(sql).not.toContain("candidate_outcomes");
      expect(sql).toContain("UNION ALL");
    }
  });

  const STATUS_RULE =
    "multiIf(countIf(run.outcome != 'skipped') = 0, 'skipped', argMax(run.outcome, (run.outcome != 'skipped', run.started_at, run.ended_at, toString(run.id))) IN ('failed', 'error', 'crashed'), 'failed', argMax(run.outcome, (run.outcome != 'skipped', run.started_at, run.ended_at, toString(run.id))) = 'timed_out', 'timed_out', argMax(run.outcome, (run.outcome != 'skipped', run.started_at, run.ended_at, toString(run.id))) = 'passed', if(countIf(run.outcome IN ('failed', 'error', 'crashed', 'timed_out')) > 0, 'flaky', 'passed'), argMax(run.outcome, (run.outcome != 'skipped', run.started_at, run.ended_at, toString(run.id))) = 'xfailed', 'xfailed', 'other')";

  test("selects a status by the bundle status rule and orders by executed time", () => {
    const { sql, params } = buildCommitRunsQuery(
      {
        ...query,
        status: ["flaky", "timed_out"],
        sort: ["-duration_milliseconds"],
      },
      null
    );
    expect(params.status).toEqual(["flaky", "timed_out"]);
    expect(sql).toContain(`HAVING ${STATUS_RULE} IN {status: Array(String)}`);
    expect(sql).toContain(
      "sum(if(run.outcome != 'skipped', greatest(0, toUnixTimestamp64Milli(run.ended_at) - toUnixTimestamp64Milli(run.started_at)), 0)) AS duration_milliseconds"
    );
    expect(sql).toContain(
      "ORDER BY run.duration_milliseconds DESC, run.tests_id ASC"
    );
    expect(sql).toContain("toString(run.duration_milliseconds) AS sort_0");
    // The passed status reads every bundle: the shared-start read, with
    // the chronology columns the status rule needs, whatever the sort; the
    // rule reads run.outcome, so the source carries it even when no sort
    // or attempt filter does (a 500 on the passed section, 2026-10-31).
    for (const sort of [
      ["-duration_milliseconds"],
      ["-started_at"],
      ["file"],
    ]) {
      const passed = buildCommitRunsQuery(
        { ...query, status: ["passed"], sort },
        null
      ).sql;
      expect(passed).toContain("UNION ALL");
      expect(passed).toContain(
        `${GROUP_COLUMNS}, run.started_at AS started_at, run.ended_at AS ended_at, run.id AS id, run.outcome AS outcome\n`
      );
    }
  });

  const STATUSES_SQL =
    "['failed', 'timed_out', 'flaky', 'passed', 'other', 'xfailed', 'skipped']";
  // The status sort's rank, best first, so -status puts the worst first.
  const STATUS_RANK_SQL =
    "['skipped', 'xfailed', 'other', 'passed', 'flaky', 'timed_out', 'failed']";

  const RANKED_COLUMNS =
    "tests_id, environments_id, env_vars_id, github_workflow_job_id";
  const WORST_RANK = `${STATUSES_SQL}[min(indexOf(${STATUSES_SQL}, status)) OVER (PARTITION BY tests_id)] AS worst_status`;

  test("ranks every bundle of a test by a window before the status filters select among them when worst_status is set", () => {
    // The commit page's passed section: the bundles of the status whose
    // tests have it as their worst over all their bundles on the commit.
    const { sql, params } = buildCommitRunsQuery(
      {
        ...query,
        status: ["passed"],
        worst_status: ["passed"],
        sort: ["-duration_milliseconds"],
      },
      null
    );
    expect(params).toMatchObject({
      status: ["passed"],
      worst_status: ["passed"],
    });
    expect(params).not.toHaveProperty("candidate_outcomes");
    // The grouped bundles carry their statuses instead of a HAVING on them.
    expect(sql).not.toContain("HAVING multiIf");
    expect(sql).toContain(
      `        sum(if(run.outcome != 'skipped', greatest(0, toUnixTimestamp64Milli(run.ended_at) - toUnixTimestamp64Milli(run.started_at)), 0)) AS duration_milliseconds,\n        ${STATUS_RULE} AS status\n    FROM (`
    );
    expect(sql).toContain(
      `FROM (\n    SELECT ${RANKED_COLUMNS}, duration_milliseconds, status,\n        ${WORST_RANK}\n    FROM (\n    SELECT run.tests_id AS tests_id,`
    );
    expect(sql).toContain(
      "\n) AS run\nWHERE run.status IN {status: Array(String)}\n    AND run.worst_status IN {worst_status: Array(String)}\n    AND (1)\nORDER BY run.duration_milliseconds DESC"
    );
    // Every bundle of the commit is read through the shared starts, once.
    expect(sql.match(/UNION ALL/g)).toHaveLength(1);
    expect(sql).toContain(
      `${GROUP_COLUMNS}, run.started_at AS started_at, run.ended_at AS ended_at, run.id AS id, run.outcome AS outcome\n`
    );
  });

  test("applies the identity and attempt filters after the ranking, so the worst status is over every bundle of the test", () => {
    const { sql, params } = buildCommitRunsQuery(
      {
        ...query,
        environments_id: [ENVIRONMENT_ID],
        outcome: ["failed"],
        last_attempt_outcome: ["passed"],
        worst_status: ["flaky"],
      },
      null
    );
    // The source reads the commit's rows alone, pruned to the tests holding
    // a failing row: a flaky bundle holds one.
    expect(params.candidate_outcomes).toEqual(["failed"]);
    expect(sql).toContain(
      `FROM ci.runs AS run FINAL\n    PREWHERE run.tests_id IN (SELECT run.tests_id\n        FROM ci.runs AS run\n        WHERE ${COMMIT_JOBS}\n            AND run.outcome IN {candidate_outcomes: Array(String)}\n        GROUP BY run.tests_id)\n    WHERE ${COMMIT_JOBS}\n    GROUP BY`
    );
    expect(sql).not.toMatch(
      /WHERE run\.github_workflow_job_id IN \(SELECT arrayJoin\(matched_job_ids\)\)\s+AND run\.environments_id/
    );
    // The attempt filters and the status are columns of the grouped rows.
    expect(sql).toContain(
      `        countIf(run.outcome IN {outcome: Array(String)}) > 0 AS attempt_matched,\n        argMax(run.outcome, (run.started_at, run.ended_at, toString(run.id))) AS last_outcome,\n        ${STATUS_RULE} AS status\n    FROM`
    );
    expect(sql).toContain(
      `SELECT ${RANKED_COLUMNS}, started_at, attempt_matched, last_outcome, status,\n        ${WORST_RANK}`
    );
    expect(sql).toContain(
      "\n) AS run\nWHERE run.environments_id IN CAST({environments_id: Array(String)}, 'Array(UInt64)')\n    AND run.attempt_matched\n    AND run.last_outcome IN {last_attempt_outcome: Array(String)}\n    AND run.worst_status IN {worst_status: Array(String)}\n    AND (1)"
    );
    expect(sql).not.toContain("HAVING");
    // Without the filter the grouping keeps its HAVING conditions and the
    // identity filters stay in the source.
    const plain = buildCommitRunsQuery(
      {
        ...query,
        environments_id: [ENVIRONMENT_ID],
        outcome: ["failed"],
        last_attempt_outcome: ["passed"],
      },
      null
    ).sql;
    expect(plain).toContain(
      `    WHERE ${COMMIT_JOBS}\n        AND run.environments_id IN CAST({environments_id: Array(String)}, 'Array(UInt64)')\n    GROUP BY`
    );
    expect(plain).toContain(
      "HAVING countIf(run.outcome IN {outcome: Array(String)}) > 0\n        AND argMax(run.outcome, (run.started_at, run.ended_at, toString(run.id))) IN {last_attempt_outcome: Array(String)}\n) AS run"
    );
    expect(plain).not.toContain("OVER (PARTITION BY");
  });

  test("sorts by the bundle status, the worst first with -status, the status rule a column of the grouped rows", () => {
    // The commit page's list: the outcomes it shows, in outcome order and
    // then longest first, in one request with one cursor.
    const { sql, params } = buildCommitRunsQuery(
      {
        ...query,
        status: ["failed", "timed_out", "flaky", "other"],
        sort: ["-status", "-duration_milliseconds"],
      },
      null
    );
    expect(params.status).toEqual(["failed", "timed_out", "flaky", "other"]);
    expect(sql).toContain(`${STATUS_RULE} AS status`);
    expect(sql).toContain(
      `toString(indexOf(${STATUS_RANK_SQL}, run.status)) AS sort_0`
    );
    expect(sql).toContain("toString(run.duration_milliseconds) AS sort_1");
    expect(sql).toContain(
      `ORDER BY indexOf(${STATUS_RANK_SQL}, run.status) DESC, run.duration_milliseconds DESC, run.tests_id ASC`
    );
    // The failing outcomes, an unexpected pass and an unknown prune the read
    // by primary key, as the page's filters did before the sort.
    expect(params.candidate_outcomes).toEqual([
      "crashed",
      "error",
      "failed",
      "timed_out",
      "unknown",
      "xpassed",
    ]);
    // The sort alone, no status filter: the status rule reads every
    // attempt's outcome and the chronology through the shared-start read.
    const sorted = buildCommitRunsQuery(
      { ...query, sort: ["-status", "-started_at"] },
      null
    ).sql;
    expect(sorted).toContain("UNION ALL");
    expect(sorted).toContain(`${STATUS_RULE} AS status`);
    expect(sorted).toContain(
      `${GROUP_COLUMNS}, run.started_at AS started_at, run.ended_at AS ended_at, run.id AS id, run.outcome AS outcome\n`
    );
    // With a worst_status ranking the grouped rows carry the status
    // already; it is not read twice.
    const ranked = buildCommitRunsQuery(
      {
        ...query,
        worst_status: ["flaky"],
        sort: ["-status", "-duration_milliseconds"],
      },
      null
    ).sql;
    expect(ranked.split(`${STATUS_RULE} AS status`)).toHaveLength(2);
  });

  test("sorts by the job's name and the env var set's TEST_CONFIG through their catalogs", () => {
    const { sql } = buildCommitRunsQuery(
      { ...query, sort: ["job_name", "test_config", "-started_at"] },
      null
    );
    expect(sql).toContain("nullIf(job.name, '') AS job_name");
    expect(sql).toContain(
      "LEFT JOIN (\n    SELECT env_var_set.id AS id, env_var_set.env_vars['TEST_CONFIG'] AS test_config, toUInt8(1) AS has_catalog\n    FROM ci.env_vars AS env_var_set FINAL\n    WHERE 1\n) AS run_env_vars ON run_env_vars.id = run.env_vars_id"
    );
    expect(sql).toContain(
      "ORDER BY run_workflow.job_name ASC NULLS LAST, if(run_env_vars.has_catalog = 1, run_env_vars.test_config, NULL) ASC NULLS LAST, run.started_at DESC"
    );
    const filtered = buildCommitRunsQuery(
      { ...query, test_config: ["default", "slow"] },
      null
    );
    expect(filtered.params.filter_test_config).toEqual(["default", "slow"]);
    expect(filtered.sql).toContain(
      "run.env_vars_id IN (\n        SELECT id FROM ci.env_vars AS env_var_set FINAL\n        WHERE env_var_set.env_vars['TEST_CONFIG'] IN {filter_test_config: Array(String)}\n    )"
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
