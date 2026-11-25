// Run from torchci with Node 22 and installed dependencies. Without --live,
// check that the recorded working-tree statements of GET /api/tests/summary
// still match the builders. --live repeats EXPLAIN and alternating runs of
// the recorded statements from before the figures shared statements (one
// per figure) and the working tree's, each version sent together as the
// endpoint sends it, and compares every figure. --record does that and then
// writes the working tree's statements and the measurements into the bundle.
// See lib/api/tests/summary/query-validation.md.
const assert = require("node:assert/strict");
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

const { TEST_VIEWS } = require("lib/api/tests/options/views");
const { parseTestSummaryParams } = require("lib/api/tests/summary/parameters");
const { figureColumns } = require("lib/api/tests/summary/query");
const { summaryStatements } = require("lib/api/tests/summary/summary");
const evidencePath = path.join(
  root,
  "lib/api/tests/summary/query-validation.json"
);

// The statements the working tree sends for a summary request, asked for at
// the given refresh, each with the figures it answers and their columns.
function generate(raw, generation) {
  const parsed = parseTestSummaryParams(raw);
  assert(parsed.success, "Recorded parameters no longer pass validation");
  return summaryStatements(parsed.data, generation).map(
    ({ statement, queryId }) => ({
      query_id: queryId,
      figures: statement.figures.map((index) => ({
        view: TEST_VIEWS[index].id,
        kind: TEST_VIEWS[index].figure.kind,
        columns: figureColumns(index),
      })),
      sql: statement.sql,
      params: statement.params,
    })
  );
}

// A figure as both versions answer it, numbers as decimal strings.
function figure(kind, count, duration, testsId) {
  switch (kind) {
    case "count":
      return { count: String(count ?? 0) };
    case "total_duration":
      return { duration_milliseconds: String(duration ?? 0) };
    case "slowest":
      return duration === null || duration === undefined
        ? { none: true }
        : {
            tests_id: String(testsId),
            duration_milliseconds: String(duration),
          };
    default:
      throw new Error(`Unknown figure kind: ${kind}`);
  }
}

// Before: a statement per figure, one row each, no row when nothing is
// slowest. After: one row per statement, a figure in its own columns.
function figuresOf(version, statements, rows) {
  const figures = {};
  statements.forEach((statement, index) => {
    if (version === "before") {
      const row = rows[index][0];
      figures[statement.view] = figure(
        statement.kind,
        row?.count,
        row?.duration_milliseconds,
        row?.tests_id_string
      );
      return;
    }
    assert.equal(rows[index].length, 1, "A statement answers one row");
    for (const { view, kind, columns } of statement.figures) {
      const row = rows[index][0];
      figures[view] = figure(
        kind,
        row[columns.count],
        row[columns.duration],
        row[columns.testsId]
      );
    }
  });
  return figures;
}

async function main() {
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  const args = process.argv.slice(2);
  const record = args.includes("--record");
  const live = record || args.includes("--live");
  const requested = args.filter((arg) => !arg.startsWith("--"));
  const names = requested.length ? requested : Object.keys(evidence.cases);
  const { generation } = evidence.fixture;
  for (const name of names) {
    const recorded = evidence.cases[name];
    assert(recorded, `Unknown validation case: ${name}`);
    if (record) {
      recorded.after = generate(recorded.raw, generation);
      continue;
    }
    assert.deepEqual(
      generate(recorded.raw, generation),
      recorded.after,
      `${name}: working-tree SQL or parameters changed`
    );
  }
  if (!live) {
    console.log(`Verified ${names.length} comparisons.`);
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
  // The health table is replaced whole at every refresh, so two reads agree
  // only when no refresh landed between them.
  const refreshedAt = async () =>
    (
      await execute({
        sql: `SELECT refreshed_at FROM ${evidence.database}.health LIMIT 1`,
        params: {},
      })
    ).body.data[0]?.refreshed_at ?? "";
  // One version's statements, sent together as the endpoint sends them.
  async function sample(version, statements) {
    const started = process.hrtime.bigint();
    const answers = await Promise.all(statements.map((s) => execute(s)));
    const wall_ms = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
    return {
      version,
      wall_ms,
      statements: answers.map(({ body, memory_usage }, index) => ({
        statement: statements[index].query_id ?? statements[index].view,
        statistics: body.statistics,
        memory_usage,
      })),
      figures: figuresOf(
        version,
        statements,
        answers.map(({ body }) => body.data)
      ),
    };
  }
  try {
    report.server_version = (
      await execute({ sql: "SELECT version() AS version", params: {} })
    ).body.data[0].version;
    for (const name of names) {
      const recorded = evidence.cases[name];
      const result = { plans: {}, samples: [] };
      for (const version of ["before", "after"]) {
        result.plans[version] = {};
        for (const statement of recorded[version]) {
          const plans = {};
          for (const plan of ["indexes = 1", "ESTIMATE"]) {
            plans[plan] = (
              await execute(statement, `EXPLAIN ${plan} `)
            ).body.data;
          }
          result.plans[version][statement.query_id ?? statement.view] = plans;
        }
      }
      let reference;
      for (let pair = 0; pair < evidence.pairs; pair++) {
        for (let attempt = 0; ; attempt++) {
          const refreshed = await refreshedAt();
          const samples = [];
          for (const version of pair % 2
            ? ["after", "before"]
            : ["before", "after"]) {
            samples.push(await sample(version, recorded[version]));
          }
          if ((await refreshedAt()) !== refreshed) {
            // A refresh landed between the two reads: compare again.
            assert(attempt < 3, `${name}: the health table kept refreshing`);
            continue;
          }
          assert.deepEqual(
            samples[0].figures,
            samples[1].figures,
            `${name}: figures differ between the versions`
          );
          for (const { figures, ...rest } of samples) {
            result.samples.push({ pair, refreshed_at: refreshed, ...rest });
            reference = figures;
          }
          break;
        }
      }
      // A case that stands for a repository with tests must count some.
      const counted = Object.values(reference).some(
        (value) => !value.none && Object.values(value).some((v) => v !== "0")
      );
      assert(
        counted || recorded.empty === true,
        `${name}: fixture expired or empty`
      );
      result.figures = reference;
      result.equal_figures = true;
      report.cases[name] = result;
      console.error(`Validated ${name}: ${JSON.stringify(reference)}`);
    }
    report.measured_until = new Date().toISOString();
    if (!record) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const { server_version, measured_at, measured_until } = report;
    Object.assign(evidence, { measured_at, measured_until, server_version });
    for (const name of names) {
      Object.assign(evidence.cases[name], report.cases[name]);
    }
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`Recorded ${names.length} comparisons.`);
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
