// Run from torchci with Node 22 and installed dependencies. The tests list,
// detail and boundary-probe queries have no before/after comparison; this
// replays their recorded working-tree SQL. Without --live it checks that the
// recorded SQL and bindings still match the builders. --live reruns each case
// against ClickHouse with EXPLAIN indexes=1 and EXPLAIN ESTIMATE, then three
// executions that must return the same nonempty complete rows.
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

const { buildListQuery } = require("lib/api/tests/query");
const { buildTestDetailQuery } = require("lib/api/tests/test/query");
const { parseTestListParams } = require("lib/api/tests/parameters");
const evidencePath = path.join(root, "lib/api/tests/query-validation.json");
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

// kind "list": a page; "probe": the boundary probe the handler issues for a
// cursor page, built with limit 0 so the SQL asks for one row; "detail": a test.
function generate({ kind, raw, cursor = null }) {
  if (kind === "detail") return buildTestDetailQuery(raw.test_id);
  const parsed = parseTestListParams(raw);
  assert(parsed.success, "Recorded parameters no longer pass validation");
  const { cursor: _cursor, ...query } = parsed.data;
  return buildListQuery(
    kind === "probe" ? { ...query, limit: 0 } : query,
    cursor
  );
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
    assert.deepEqual(
      generate(recorded),
      recorded.query,
      `${name}: working-tree SQL or parameters changed`
    );
  }
  if (!live) {
    console.log(`Verified ${names.length} working-tree queries.`);
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
  const report = { measured_at: new Date().toISOString(), cases: {} };
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
    for (const name of names) {
      const { query } = evidence.cases[name];
      const result = { plans: {}, samples: [] };
      for (const plan of ["indexes = 1", "ESTIMATE"]) {
        result.plans[plan] = (
          await execute(query, `EXPLAIN ${plan} `)
        ).body.data;
      }
      let reference;
      for (let execution = 0; execution < evidence.executions; execution++) {
        const { body, memory_usage } = await execute(query);
        assert(body.data.length > 0, `${name}: fixture expired or empty`);
        reference ??= body.data;
        assert.deepEqual(body.data, reference, `${name}: rows changed`);
        result.samples.push({
          execution,
          rows: body.rows,
          statistics: body.statistics,
          memory_usage,
          digest: digest(body.data),
        });
      }
      result.rows = reference.length;
      result.digest = digest(reference);
      report.cases[name] = result;
      console.error(`Validated ${name}: ${reference.length} rows`);
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
module.exports = { generate };
