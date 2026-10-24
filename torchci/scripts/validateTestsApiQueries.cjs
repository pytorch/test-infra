// Run from torchci with Node 22 and installed dependencies. Without --live this
// only checks that the recorded candidates still match the working-tree SQL.
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  return resolveFilename.call(
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
const { buildRunsQuery } = require("lib/api/tests/test/runs/query");
const { parseRunsListParams } = require("lib/api/tests/test/runs/parameters");
const {
  buildCommitRunsQuery,
  buildCommitRunsStatsQuery,
} = require("lib/api/tests/commit/query");
const {
  parseCommitRunsListParams,
} = require("lib/api/tests/commit/parameters");

function queryFrom(parser, raw) {
  const result = parser(raw);
  assert(result.success, "Recorded request no longer passes validation");
  const { cursor: _cursor, ...query } = result.data;
  return query;
}

function generate(name, raw) {
  if (name === "detail") return buildTestDetailQuery(raw.id);
  if (name.startsWith("main_")) {
    return buildListQuery(queryFrom(parseTestListParams, raw), null);
  }
  if (name.startsWith("runs_")) {
    return buildRunsQuery(queryFrom(parseRunsListParams, raw), null);
  }
  if (name === "commit_stats") {
    return buildCommitRunsStatsQuery(queryFrom(parseCommitRunsListParams, raw));
  }
  if (name.startsWith("commit_")) {
    return buildCommitRunsQuery(
      queryFrom(parseCommitRunsListParams, raw),
      null
    );
  }
  throw new Error(`Unknown validation case: ${name}`);
}

// Each bundle records the queries one review changed; later bundles cover
// queries changed since.
const BUNDLES = ["review-2026-10-22.json", "commit-runs-2026-10-23.json"];

async function main() {
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const evidence = { cases: {} };
  for (const bundle of BUNDLES) {
    const { cases } = JSON.parse(
      fs.readFileSync(
        path.join(root, "lib/api/tests/validation", bundle),
        "utf8"
      )
    );
    for (const [name, recorded] of Object.entries(cases)) {
      assert(!evidence.cases[name], `${name} is recorded twice`);
      evidence.cases[name] = recorded;
    }
  }
  const requested = args.filter((arg) => arg !== "--live");
  const names = requested.length ? requested : Object.keys(evidence.cases);
  for (const name of names) {
    const recorded = evidence.cases[name];
    assert(recorded, `Unknown validation case: ${name}`);
    const current = generate(name, recorded.after.raw);
    assert.equal(current.sql, recorded.after.sql, `${name}: SQL has changed`);
    assert.deepEqual(
      current.params,
      recorded.after.params,
      `${name}: parameters have changed`
    );
    for (const version of ["before", "after"]) {
      assert.equal(
        createHash("sha256").update(recorded[version].sql).digest("hex"),
        recorded[version].sql_sha256,
        `${name}: ${version} SQL hash does not match its recorded statement`
      );
    }
  }
  if (!live) {
    console.log(
      `Verified ${names.length} working-tree queries against recorded SQL.`
    );
    return;
  }

  require("dotenv").config({ path: path.join(root, ".env.local") });
  for (const name of [
    "CLICKHOUSE_HUD_USER_URL",
    "CLICKHOUSE_HUD_USER_USERNAME",
    "CLICKHOUSE_HUD_USER_PASSWORD",
  ]) {
    assert(process.env[name], `Missing connection setting: ${name}`);
  }
  const { createClient } = require("@clickhouse/client");
  const client = createClient({
    url: process.env.CLICKHOUSE_HUD_USER_URL,
    username: process.env.CLICKHOUSE_HUD_USER_USERNAME,
    password: process.env.CLICKHOUSE_HUD_USER_PASSWORD,
    request_timeout: 105000,
  });
  async function execute(query, explain = "") {
    assert(/^\s*(WITH|SELECT)\b/i.test(query.sql), "Expected read-only SQL");
    const result = await client.query({
      query: explain + query.sql,
      query_params: query.params,
      format: "JSON",
      clickhouse_settings: {
        readonly: "2",
        use_query_cache: 0,
        max_execution_time: 90,
        output_format_json_quote_64bit_integers: 1,
        date_time_output_format: "iso",
      },
    });
    return {
      ...(await result.json()),
      http_summary: JSON.parse(
        result.response_headers["x-clickhouse-summary"] || "{}"
      ),
    };
  }
  const report = { measured_at: new Date().toISOString(), cases: {} };
  try {
    for (const name of names) {
      const variants = evidence.cases[name];
      const result = { plans: {}, samples: [] };
      for (const version of ["before", "after"]) {
        result.plans[version] = {};
        for (const explain of ["indexes = 1", "PIPELINE"]) {
          result.plans[version][explain] = (
            await execute(variants[version], `EXPLAIN ${explain} `)
          ).data;
        }
      }
      let reference;
      for (let pair = 0; pair < 4; pair++) {
        // Reverse each pair as well as alternating variants to reduce bias.
        const order = pair % 2 ? ["after", "before"] : ["before", "after"];
        for (const version of order) {
          const response = await execute(variants[version]);
          assert(response.data.length > 0, `${name}: fixture has no rows`);
          reference ??= response.data;
          assert.deepEqual(
            response.data,
            reference,
            `${name}: rows changed; inspect correctness or a health refresh`
          );
          result.samples.push({
            pair,
            version,
            rows: response.data.length,
            statistics: response.statistics,
            http_summary: response.http_summary,
          });
        }
      }
      result.equal_complete_rows = true;
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
