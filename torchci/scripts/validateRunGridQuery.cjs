// Run from torchci. Replays the recorded grid query (GET
// /api/tests/test/{test_id}/runs?group_by=commit) from the working-tree
// builder and fails when its SQL or bindings differ from the evidence.
// --live regenerates the evidence instead: it records the working-tree SQL,
// runs EXPLAIN, times each recorded case in alternating rounds with the
// query cache off, and compares the rows of the kept query with the rewrite
// that was measured and rejected (the metadata reads without FINAL). Runs
// keep arriving while it works, so the timed and compared statements are
// bounded above by one instant, a day before the run (`until_ms`), in
// the two places the window start is bound and where the chains read
// starts; the recorded SQL is the production statement, open-ended as the
// handler sends it.
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request.startsWith("lib/")) request = path.join(root, request);
  return resolve.call(this, request, parent, isMain, options);
};
require.extensions[".ts"] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  });
  module._compile(outputText, filename);
};
const { buildRunGridQuery } = require("lib/api/tests/test/runs/grid-query");
const { parseRunsGridParams } = require("lib/api/tests/test/runs/parameters");
const evidencePath = path.join(
  root,
  "lib/api/tests/test/runs/grid-query-validation.json"
);
const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

// The rewrite considered: the two metadata reads without FINAL, which their
// ORDER BY ... LIMIT 1 BY already deduplicates.
function withoutFinal(query) {
  return {
    params: query.params,
    sql: query.sql
      .replace("FROM default.workflow_job FINAL", "FROM default.workflow_job")
      .replace("FROM default.workflow_run FINAL", "FROM default.workflow_run"),
  };
}

function generate(testCase) {
  const parsed = parseRunsGridParams(testCase.raw);
  assert(
    parsed.success,
    `Recorded raw query no longer parses: ${testCase.name}`
  );
  return buildRunGridQuery(parsed.data, testCase.since_ms);
}

// The statement bounded above by `until`, Unix milliseconds, wherever it
// bounds the attempts below, so two runs seconds apart read the same rows.
const WINDOW_START =
  "run.started_at >= fromUnixTimestamp64Milli({since: Int64}, 'UTC')";
const CHAINS_START =
  "run.started_at >= fromUnixTimestamp64Milli({chains_since: Int64}, 'UTC')";
const UNTIL =
  "run.started_at < fromUnixTimestamp64Milli({until: Int64}, 'UTC')";
function boundedUntil(query, until) {
  assert.equal(
    query.sql.split(WINDOW_START).length - 1,
    2,
    "Expected the window start bound in the two job reads"
  );
  assert.equal(
    query.sql.split(CHAINS_START).length - 1,
    1,
    "Expected the chains read to start a day before the window"
  );
  return {
    params: { ...query.params, until },
    sql: query.sql
      .split(WINDOW_START)
      .join(`${WINDOW_START} AND ${UNTIL}`)
      .split(CHAINS_START)
      .join(`${CHAINS_START} AND ${UNTIL}`),
  };
}

// What of a result is recorded: its size in rows (one per job's chain of
// attempts) and in cells (a lane and a commit), its digest and each lane's
// chains by their job's final outcome, so a change in the rows is visible
// without the rows.
function summarize(rows) {
  const lanes = new Map();
  for (const row of rows) {
    const key = `${row.workflow_path}|${row.environments_id_string}|${row.env_vars_id_string}`;
    const lane = lanes.get(key) ?? {
      lane: key,
      chains: 0,
      commits: new Set(),
      outcomes: {},
    };
    lane.chains += 1;
    lane.commits.add(row.commit_sha);
    lane.outcomes[row.outcome] = (lane.outcomes[row.outcome] ?? 0) + 1;
    lanes.set(key, lane);
  }
  const summarized = Array.from(lanes.values(), (lane) => ({
    lane: lane.lane,
    chains: lane.chains,
    cells: lane.commits.size,
    outcomes: lane.outcomes,
  }));
  return {
    rows: rows.length,
    cells: summarized.reduce((sum, lane) => sum + lane.cells, 0),
    commits: new Set(rows.map((row) => row.commit_sha)).size,
    digest: digest(rows),
    lanes: summarized.sort((a, b) => a.lane.localeCompare(b.lane)),
  };
}

async function main() {
  if (!process.argv.includes("--live")) {
    for (const testCase of evidence.cases) {
      assert.deepEqual(
        generate(testCase),
        testCase.query,
        `Working-tree SQL or parameters changed for ${testCase.name}; regenerate and remeasure evidence`
      );
    }
    console.log(
      `Verified the working-tree grid query for ${evidence.cases.length} cases.`
    );
    return;
  }
  // A day back: a test's rows land when its job ends, hours after it ran.
  const until = Date.now() - 24 * 3600 * 1000;

  require("dotenv").config({ path: path.join(root, ".env.local") });
  const { createClient } = require("@clickhouse/client");
  const client = createClient({
    url: process.env.CLICKHOUSE_HUD_USER_URL,
    username: process.env.CLICKHOUSE_HUD_USER_USERNAME,
    password: process.env.CLICKHOUSE_HUD_USER_PASSWORD,
    request_timeout: 120000,
  });
  async function execute(query, prefix = "") {
    assert(/^\s*(WITH|SELECT)\b/i.test(query.sql), "Expected read-only SQL");
    const response = await client.query({
      query: prefix + query.sql,
      query_params: query.params,
      format: "JSON",
      clickhouse_settings: evidence.settings,
    });
    const summary = response.response_headers["x-clickhouse-summary"];
    const body = await response.json();
    return {
      body,
      memory_usage: Number(
        summary
          ? JSON.parse(Array.isArray(summary) ? summary[0] : summary)
              .memory_usage
          : 0
      ),
    };
  }
  try {
    const report = {
      ...evidence,
      measured_at: new Date().toISOString(),
      server: (
        await execute({
          sql: "SELECT version() AS version, currentDatabase() AS database",
          params: {},
        })
      ).body.data[0],
      cases: [],
    };
    for (const testCase of evidence.cases) {
      const query = generate(testCase);
      const variants = {
        kept: boundedUntil(query, until),
        without_final: boundedUntil(withoutFinal(query), until),
      };
      const recorded = {
        ...testCase,
        until_ms: until,
        query,
        plans: {},
        samples: [],
      };
      for (const plan of ["indexes = 1", "ESTIMATE"]) {
        recorded.plans[plan] = (
          await execute(query, `EXPLAIN ${plan} `)
        ).body.data.map((row) => row.explain ?? JSON.stringify(row));
      }
      const results = {};
      for (let round = 0; round < 4; round++) {
        const order =
          round % 2 ? ["without_final", "kept"] : ["kept", "without_final"];
        for (const variant of order) {
          const { body, memory_usage } = await execute(variants[variant]);
          results[variant] = summarize(body.data);
          recorded.samples.push({
            round,
            variant,
            rows: body.rows,
            statistics: body.statistics,
            memory_usage,
          });
        }
      }
      assert.equal(
        results.without_final.digest,
        results.kept.digest,
        `The rewrite returned other rows: ${testCase.name}`
      );
      recorded.result = results.kept;
      report.cases.push(recorded);
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await client.close();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
