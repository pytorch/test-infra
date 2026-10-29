// Run from torchci with Node 22 and installed dependencies. Without --live,
// check that the recorded commit statistics SQL still matches the builder and
// that the recorded functional baseline still derives from it. --live repeats
// EXPLAIN and alternating, complete-row comparisons of the baseline, a plain
// FINAL read of the commit's runs grouped into bundles, with the working-tree
// SQL for each case, and prints the complete evidence document.
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  return resolve.call(
    this,
    request.startsWith("lib/") ? path.join(root, request) : request,
    parent,
    isMain,
    options
  );
};
require.extensions[".ts"] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  });
  module._compile(outputText, filename);
};

const { buildCommitRunsStatsQuery } = require("lib/api/tests/commit/query");
const {
  parseCommitRunsListParams,
} = require("lib/api/tests/commit/parameters");
const { CI_DATABASE } = require("lib/api/tests/database");
const { FINAL_OUTCOME } = require("lib/api/tests/test/runs/query");
const { RUN_OUTCOMES } = require("lib/api/tests/test/runs/types");
const evidencePath = path.join(
  root,
  "lib/api/tests/commit/stats-query-validation.json"
);
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function generate(raw) {
  const parsed = parseCommitRunsListParams(raw);
  assert(parsed.success, "Recorded parameters no longer pass validation");
  const { cursor: _cursor, ...query } = parsed.data;
  return buildCommitRunsStatsQuery(query);
}

// The functional baseline: the working-tree commit membership, then every
// retained run of those jobs read with FINAL and grouped into bundles, each
// counted under the same final outcome. No pruning beyond the job filter.
function functionalBaseline(after) {
  const marker = " AS matched_job_ids";
  const membership = after.sql.slice(
    0,
    after.sql.indexOf(marker) + marker.length
  );
  assert(
    membership.includes("FROM default.workflow_job"),
    "No membership scalar"
  );
  return {
    params: after.params,
    sql: `${membership}
SELECT count() AS total,
    ${RUN_OUTCOMES.map(
      (outcome) => `countIf(final_outcome = '${outcome}') AS ${outcome}`
    ).join(",\n    ")}
FROM (
    SELECT ${FINAL_OUTCOME} AS final_outcome
    FROM ${CI_DATABASE}.runs AS run FINAL
    WHERE run.github_workflow_job_id IN (SELECT arrayJoin(matched_job_ids))
    GROUP BY run.tests_id, run.environments_id, run.env_vars_id, run.github_workflow_job_id
)
SETTINGS optimize_move_to_prewhere_if_final = 0
`,
  };
}

async function main() {
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const requested = args.filter((arg) => arg !== "--live");
  const names = requested.length ? requested : Object.keys(evidence.cases);
  for (const name of names) {
    const recorded = evidence.cases[name];
    assert(recorded, `Unknown validation case: ${name}`);
    const after = generate(recorded.raw);
    assert.deepEqual(
      after,
      recorded.after,
      `${name}: working-tree SQL or parameters changed`
    );
    assert.deepEqual(
      functionalBaseline(after),
      recorded.before,
      `${name}: functional baseline changed`
    );
  }
  if (!live) {
    console.log(`Verified ${names.length} statistics comparisons.`);
    return;
  }
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
    const result = await client.query({
      query: prefix + query.sql,
      query_params: query.params,
      format: "JSON",
      clickhouse_settings: evidence.settings,
    });
    const summary = result.response_headers["x-clickhouse-summary"];
    return {
      body: await result.json(),
      memory_usage: summary
        ? JSON.parse(Array.isArray(summary) ? summary[0] : summary).memory_usage
        : null,
    };
  }
  try {
    const report = {
      ...evidence,
      measured_at: new Date().toISOString(),
      server_version: (
        await execute({ sql: "SELECT version() AS version", params: {} })
      ).body.data[0].version,
      cases: {},
    };
    for (const name of names) {
      const { raw, before, after } = evidence.cases[name];
      const result = { raw, before, after, plans: {}, samples: [] };
      for (const [version, query] of [
        ["before", before],
        ["after", after],
      ]) {
        result.plans[version] = {};
        for (const plan of ["indexes = 1", "ESTIMATE"]) {
          result.plans[version][plan] = (
            await execute(query, `EXPLAIN ${plan} `)
          ).body.data;
        }
      }
      let reference;
      for (let pair = 0; pair < evidence.pairs; pair++) {
        for (const version of pair % 2
          ? ["after", "before"]
          : ["before", "after"]) {
          const query = version === "before" ? before : after;
          const { body, memory_usage } = await execute(query);
          // An aggregate returns one row; an unknown commit returns zeros.
          assert.equal(body.data.length, 1, `${name}: expected one row`);
          reference ??= body.data;
          assert.deepEqual(body.data, reference, `${name}: rows differ`);
          result.samples.push({
            pair,
            version,
            rows: body.rows,
            statistics: body.statistics,
            memory_usage,
            digest: digest(body.data),
          });
        }
      }
      result.rows = reference;
      result.digest = digest(reference);
      result.equal_complete_rows = true;
      report.cases[name] = result;
      console.error(`Validated ${name}: ${JSON.stringify(reference[0])}`);
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await client.close();
  }
}
if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
module.exports = { generate, functionalBaseline };
