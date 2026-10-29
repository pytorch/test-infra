// Run from torchci. Without --live, verify the recorded SQL still matches the
// builders. --live replays EXPLAIN and alternating, exact-row comparisons.
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

const { buildRunsQuery } = require("lib/api/tests/test/runs/query");
const {
  buildRunAttemptsQuery,
} = require("lib/api/tests/test/runs/attempts-query");
const { buildCommitRunsQuery } = require("lib/api/tests/commit/query");
const { parseRunsListParams } = require("lib/api/tests/test/runs/parameters");
const {
  parseCommitRunsListParams,
} = require("lib/api/tests/commit/parameters");
const evidence = JSON.parse(
  fs.readFileSync(
    path.join(root, "lib/api/tests/test/runs/attempts-query-validation.json"),
    "utf8"
  )
);
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function generate(recorded) {
  const { kind, raw, cursor = null } = recorded;
  if (kind === "attempts") return buildRunAttemptsQuery(raw);
  const parser =
    kind === "test" ? parseRunsListParams : parseCommitRunsListParams;
  const parsed = parser(raw);
  assert(parsed.success, "Recorded parameters no longer pass validation");
  const { cursor: _cursor, ...query } = parsed.data;
  return (kind === "test" ? buildRunsQuery : buildCommitRunsQuery)(
    query,
    cursor
  );
}

async function main() {
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const requested = args.filter((arg) => arg !== "--live");
  const names = requested.length ? requested : Object.keys(evidence.cases);
  for (const name of names) {
    const recorded = evidence.cases[name];
    assert(recorded, `Unknown validation case: ${name}`);
    assert.deepEqual(
      generate(recorded),
      recorded.versions.after,
      `${name}: working-tree SQL or parameters changed`
    );
  }
  if (!live) {
    console.log(`Verified ${names.length} working-tree attempt queries.`);
    return;
  }
  require("dotenv").config({ path: path.join(root, ".env.local") });
  const { createClient } = require("@clickhouse/client");
  const client = createClient({
    url: process.env.CLICKHOUSE_HUD_USER_URL,
    username: process.env.CLICKHOUSE_HUD_USER_USERNAME,
    password: process.env.CLICKHOUSE_HUD_USER_PASSWORD,
    request_timeout: 105000,
  });
  const report = { measured_at: new Date().toISOString(), cases: {} };
  async function execute(query, prefix = "") {
    assert(/^\s*(WITH|SELECT)\b/i.test(query.sql), "Expected read-only SQL");
    const result = await client.query({
      query: prefix + query.sql,
      query_params: query.params,
      format: "JSON",
      clickhouse_settings: evidence.settings,
    });
    return result.json();
  }
  try {
    for (const name of names) {
      const { versions } = evidence.cases[name];
      const result = { plans: {}, samples: [] };
      for (const version of ["before", "after"]) {
        result.plans[version] = {};
        for (const plan of ["indexes=1", "PIPELINE"]) {
          result.plans[version][plan] = (
            await execute(versions[version], `EXPLAIN ${plan} `)
          ).data;
        }
      }
      let reference;
      for (let pair = 0; pair < 3; pair++) {
        for (const version of pair % 2
          ? ["after", "before"]
          : ["before", "after"]) {
          const response = await execute(versions[version]);
          assert(response.data.length > 0, `${name}: fixture expired or empty`);
          reference ??= response.data;
          assert.deepEqual(response.data, reference, `${name}: rows differ`);
          result.samples.push({
            pair,
            version,
            rows: response.rows,
            statistics: response.statistics,
            digest: digest(response.data),
          });
        }
      }
      report.cases[name] = result;
      console.error(`Validated ${name}`);
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
