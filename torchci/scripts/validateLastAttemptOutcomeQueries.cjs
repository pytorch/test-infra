// From torchci, use Node 22. Without --live, check the recorded working-tree
// SQL. --live repeats EXPLAIN and three alternating, complete-row comparisons.
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
const evidencePath = path.join(
  root,
  "lib/api/tests/test/runs/last-attempt-outcome-query-validation.json"
);
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function generate({ kind, raw, cursor = null }) {
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

const groupFields = [
  "tests_id",
  "environments_id",
  "env_vars_id",
  "github_workflow_job_id",
];
const group = (row) =>
  Object.fromEntries(
    groupFields.map((field) => [field, row[`${field}_string`]])
  );
const groupKey = (row) => JSON.stringify(group(row));

function verifyAttempts(rows, attempts, raw) {
  const byGroup = new Map();
  for (const attempt of attempts) {
    const key = groupKey(attempt);
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(attempt);
  }
  for (const row of rows) {
    const records = byGroup.get(groupKey(row));
    assert(records?.length, "Selected bundle has no retained attempts");
    records.sort((left, right) => {
      for (const field of ["started_at", "ended_at", "id"]) {
        if (left[field] !== right[field]) {
          return left[field] < right[field] ? -1 : 1;
        }
      }
      return 0;
    });
    assert([raw.last_attempt_outcome].flat().includes(records.at(-1).outcome));
    assert(
      records.some(
        (attempt) =>
          (raw.outcome === undefined ||
            [raw.outcome].flat().includes(attempt.outcome)) &&
          (raw.rerun_number === undefined ||
            [raw.rerun_number].flat().includes(String(attempt.rerun_number)))
      ),
      "No single attempt matches the combined attempt filters"
    );
  }
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
      recorded.versions.baseline,
      `${name}: working-tree SQL or parameters changed`
    );
  }
  const checks = requested.length ? {} : evidence.functional_checks;
  for (const [name, recorded] of Object.entries(checks)) {
    assert.deepEqual(
      generate(recorded),
      recorded.query,
      `${name}: SQL changed`
    );
  }
  if (!live) {
    console.log(
      `Verified ${names.length} comparisons and ${
        Object.keys(checks).length
      } functional queries.`
    );
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
  const report = {
    measured_at: new Date().toISOString(),
    cases: {},
    functional_checks: {},
  };
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
      for (const version of ["baseline", "candidate"]) {
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
          ? ["candidate", "baseline"]
          : ["baseline", "candidate"]) {
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
      result.rows = reference;
      report.cases[name] = result;
      console.error(`Validated ${name}: ${reference.length} rows`);
    }
    for (const [name, recorded] of Object.entries(checks)) {
      const response = await execute(recorded.query);
      assert(response.data.length > 0, `${name}: fixture expired or empty`);
      const attempts = await execute(
        buildRunAttemptsQuery(response.data.map(group))
      );
      verifyAttempts(response.data, attempts.data, recorded.raw);
      report.functional_checks[name] = {
        rows: response.data,
        attempts_count: attempts.rows,
        attempts_digest: digest(attempts.data),
      };
      console.error(`Validated ${name}: ${response.rows} bundles`);
    }
    if (Object.keys(checks).length) {
      const results = report.functional_checks;
      assert.deepEqual(
        [
          ...results.test_first_page.rows.slice(0, 2),
          ...results.test_second_page.rows.slice(0, 2),
        ],
        results.test_multiple_outcomes.rows.slice(0, 4),
        "Two limit=2 pages differ from one limit=4 page"
      );
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
