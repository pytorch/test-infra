// Run from torchci with Node 22 and installed dependencies. Without --live,
// check that the recorded commit summary SQL still matches the builders:
// the counts query, its functional baseline (every row of the commit read
// through FINAL and grouped into bundles) and the commit's lookups. --live
// repeats EXPLAIN and alternating, complete-row comparisons of the baseline
// with the working-tree counts query for each case, runs each lookup once,
// and prints the complete evidence document.
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

const {
  buildCommitInfoQuery,
  buildCommitNeighboursQuery,
  buildCommitPullRequestByHeadQuery,
  buildCommitPullRequestQuery,
  buildCommitTestCountsQuery,
  commitTestCountsSql,
} = require("lib/api/tests/commit/summary/query");
const {
  parseCommitSummaryParams,
} = require("lib/api/tests/commit/summary/parameters");
const { commitRunsScope } = require("lib/api/tests/commit/query");
const { CI_DATABASE } = require("lib/api/tests/database");
const {
  BUNDLE_STATUS_SQL,
  RUN_GROUP_FIELDS,
} = require("lib/api/tests/test/runs/query");
const evidencePath = path.join(
  root,
  "lib/api/tests/commit/summary-query-validation.json"
);
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function parsed(raw) {
  const result = parseCommitSummaryParams(raw);
  assert(result.success, "Recorded parameters no longer pass validation");
  return result.data;
}

// The functional baseline: the same counts over every row of the commit read
// through FINAL and grouped into bundles, with no pruning beyond the job
// filter. Composed here from the working query's own pieces, so the
// comparison is about the pruning alone; the recorded SQL pins the text.
function baselineQuery(query) {
  const scope = commitRunsScope(query);
  return {
    params: { ...scope.params },
    sql: `${scope.prefix}
${commitTestCountsSql(`
        SELECT run.tests_id AS tests_id,
            run.github_workflow_job_id AS job_id,
            ${BUNDLE_STATUS_SQL} AS status,
            min(run.started_at) AS started_at,
            max(run.ended_at) AS ended_at
        FROM ${CI_DATABASE}.runs AS run FINAL
        WHERE ${scope.filters.join("\n            AND ")}
        GROUP BY ${RUN_GROUP_FIELDS.map((field) => `run.${field}`).join(
          ", "
        )}`)}`,
  };
}

// The working-tree counts query (after) and its functional baseline (before).
function generate(raw) {
  return {
    before: baselineQuery(parsed(raw)),
    after: buildCommitTestCountsQuery(parsed(raw)),
  };
}

// The lookups the summary makes besides the counts, each run once live: the
// commit's own, its pull request's record, the pull request its SHA has been
// the head of (a fork head's, whose runs record none) and its branch
// neighbours (a branch commit's).
function lookups(recorded) {
  const branch = {
    repo: recorded.raw.repo,
    branch: recorded.branch,
    committedAtMs: recorded.committed_at_ms,
  };
  return {
    info: buildCommitInfoQuery(parsed(recorded.raw)),
    pull_request: buildCommitPullRequestQuery(
      recorded.pull_request_number,
      recorded.raw.repo
    ),
    pull_request_by_head: buildCommitPullRequestByHeadQuery({
      sha: recorded.raw.sha,
      repo: recorded.raw.repo,
    }),
    neighbours: buildCommitNeighboursQuery(branch),
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
    const { before, after } = generate(recorded.raw);
    assert.deepEqual(
      after,
      recorded.after,
      `${name}: working-tree SQL or parameters changed`
    );
    assert.deepEqual(
      before,
      recorded.before,
      `${name}: functional baseline changed`
    );
  }
  for (const [name, recorded] of Object.entries(evidence.lookups)) {
    const generated = lookups(recorded);
    for (const kind of Object.keys(generated)) {
      assert.deepEqual(
        generated[kind],
        recorded.queries[kind],
        `${name}: ${kind} lookup SQL changed`
      );
    }
  }
  if (!live) {
    console.log(
      `Verified ${names.length} counts comparisons and ${
        Object.keys(evidence.lookups).length
      } lookup sets.`
    );
    return;
  }
  require("dotenv").config({ path: path.join(root, ".env.local") });
  const { createClient } = require("@clickhouse/client");
  const client = createClient({
    url: process.env.CLICKHOUSE_HUD_USER_URL,
    username: process.env.CLICKHOUSE_HUD_USER_USERNAME,
    password: process.env.CLICKHOUSE_HUD_USER_PASSWORD,
    request_timeout: evidence.settings.max_execution_time * 1000 + 30000,
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
      lookups: {},
    };
    for (const name of names) {
      const { raw } = evidence.cases[name];
      const { before, after } = generate(raw);
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
          // The rollup row and one row per worst result with tests.
          assert(body.data.length >= 1, `${name}: expected the rollup row`);
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
      console.error(`Validated ${name}: ${reference.length} rows`);
    }
    for (const [name, recorded] of Object.entries(evidence.lookups)) {
      const queries = lookups(recorded);
      const result = { ...recorded, queries, results: {} };
      for (const [kind, query] of Object.entries(queries)) {
        const { body, memory_usage } = await execute(query);
        result.results[kind] = {
          rows: body.rows,
          statistics: body.statistics,
          memory_usage,
          digest: digest(body.data),
        };
      }
      report.lookups[name] = result;
      console.error(`Ran the ${name} lookups`);
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
module.exports = { generate, lookups };
