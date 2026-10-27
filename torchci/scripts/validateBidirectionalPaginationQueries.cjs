// From torchci, use Node 22. Without --live, verify the recorded SQL still
// matches the working tree. --live repeats plans, alternating comparisons,
// forward/backward row checks and one-row boundary probes.
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

const { buildListQuery, sortKeys } = require("lib/api/tests/query");
const { parseTestListParams } = require("lib/api/tests/parameters");
const {
  buildRunsQuery,
  runSortKeys,
} = require("lib/api/tests/test/runs/query");
const { parseRunsListParams } = require("lib/api/tests/test/runs/parameters");
const { buildCommitRunsQuery } = require("lib/api/tests/commit/query");
const {
  parseCommitRunsListParams,
} = require("lib/api/tests/commit/parameters");
const evidencePath = path.join(
  root,
  "lib/api/tests/validation/bidirectional-pagination-2026-10-24.json"
);
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const settings = {
  readonly: "2",
  use_query_cache: 0,
  max_execution_time: 90,
  output_format_json_quote_64bit_integers: 1,
  date_time_output_format: "iso",
};

function generate({ kind, raw, cursor = null, limitOverride }) {
  const parser =
    kind === "tests"
      ? parseTestListParams
      : kind === "test"
      ? parseRunsListParams
      : parseCommitRunsListParams;
  const parsed = parser(raw);
  assert(parsed.success, "Recorded parameters no longer pass validation");
  const { cursor: _cursor, ...query } = parsed.data;
  // The list's internal existence probe requests one SQL row, not a public
  // limit=0 page. The builder adds one lookahead to this internal limit.
  if (limitOverride !== undefined) {
    assert.equal(limitOverride, 0);
    query.limit = 0;
  }
  return (
    kind === "tests"
      ? buildListQuery
      : kind === "test"
      ? buildRunsQuery
      : buildCommitRunsQuery
  )(query, cursor);
}

// Optimization experiment only: factor the lexicographic predicate's repeated
// equality prefixes. Keep all comparisons, null handling, filtering and order.
function factoredCandidate(recorded) {
  const baseline = generate(recorded);
  const { kind, raw, cursor } = recorded;
  assert(cursor);
  const sort = raw.sort ? raw.sort.split(",") : ["-started_at"];
  const keys =
    kind === "tests"
      ? sortKeys(parseTestListParams(raw).data)
      : runSortKeys({ sort }, kind === "commit");
  const previous = cursor.direction === "previous";
  let tail = null;
  for (let index = keys.length - 1; index >= 0; index--) {
    const key = keys[index];
    const column =
      kind === "tests" ? `key_${index}` : key.expression ?? `run.${key.field}`;
    const value = cursor.position.values[index];
    let strict;
    let equal;
    if (value === null) {
      strict = previous ? `isNotNull(${column})` : null;
      equal = `isNull(${column})`;
    } else {
      const bound =
        key.type === "timestamp"
          ? `fromUnixTimestamp64Milli({cursor_${index}: Int64})`
          : `{cursor_${index}: ${key.type}}`;
      const comparison =
        (key.direction.toUpperCase() === "DESC") !== previous ? "<" : ">";
      strict = `${column} ${comparison} ${bound}`;
      if (!previous && (kind === "tests" || key.nullable)) {
        strict = `(${strict} OR isNull(${column}))`;
      }
      equal = `${column} = ${bound}`;
    }
    const equalTail = tail === null ? null : `(${equal} AND ${tail})`;
    tail =
      strict && equalTail ? `(${strict} OR ${equalTail})` : strict ?? equalTail;
  }
  const end = baseline.sql.lastIndexOf("\nORDER BY ");
  const marker = kind === "tests" ? "\nWHERE " : "\n    AND (";
  const start = baseline.sql.lastIndexOf(marker, end);
  assert(start >= 0 && end > start);
  return {
    sql:
      baseline.sql.slice(0, start) +
      (kind === "tests" ? `\nWHERE ${tail}` : `\n    AND (${tail})`) +
      baseline.sql.slice(end),
    params: baseline.params,
  };
}

async function connect() {
  require("dotenv").config({ path: path.join(root, ".env.local") });
  const { createClient } = require("@clickhouse/client");
  return createClient({
    url: process.env.CLICKHOUSE_HUD_USER_URL,
    username: process.env.CLICKHOUSE_HUD_USER_USERNAME,
    password: process.env.CLICKHOUSE_HUD_USER_PASSWORD,
    request_timeout: 105000,
  });
}

async function execute(client, query, prefix = "") {
  assert(/^\s*(WITH|SELECT)\b/i.test(query.sql), "Expected read-only SQL");
  const response = await client.query({
    query: prefix + query.sql,
    query_params: query.params,
    format: "JSON",
    clickhouse_settings: settings,
  });
  return {
    ...(await response.json()),
    http_summary: JSON.parse(
      response.response_headers["x-clickhouse-summary"] || "{}"
    ),
  };
}

async function compare(client, recorded) {
  const result = { plans: {}, samples: [] };
  for (const version of ["baseline", "candidate"]) {
    result.plans[version] = {};
    for (const plan of ["indexes=1", "PIPELINE"]) {
      result.plans[version][plan] = (
        await execute(client, recorded.versions[version], `EXPLAIN ${plan} `)
      ).data;
    }
  }
  let reference;
  for (let pair = 0; pair < 3; pair++) {
    for (const version of pair % 2
      ? ["candidate", "baseline"]
      : ["baseline", "candidate"]) {
      const response = await execute(client, recorded.versions[version]);
      assert(response.data.length > 0, "Fixture expired or empty");
      reference ??= response.data;
      assert.deepEqual(
        response.data,
        reference,
        "Complete ordered rows differ"
      );
      result.samples.push({
        pair,
        version,
        rows: response.rows,
        statistics: response.statistics,
        http_summary: response.http_summary,
        digest: digest(response.data),
      });
    }
  }
  result.rows = reference;
  return result;
}

async function checkNavigation(client, recorded, referenceQuery) {
  const reference = await execute(client, referenceQuery);
  assert(reference.rows > 0, "Forward reference is empty");
  const first = await execute(client, recorded.query);
  // Compare every selected column, including cursor keys, against an original
  // forward query's contiguous slice; the backward SQL emits nearest first.
  const expected = reference.data.slice(recorded.start, recorded.end);
  if (recorded.cursor?.direction === "previous") expected.reverse();
  assert.deepEqual(first.data, expected, "Page differs from forward slice");
  return {
    reference_rows: reference.rows,
    reference_digest: digest(reference.data),
    rows: first.data,
    statistics: first.statistics,
    digest: digest(first.data),
  };
}

async function main() {
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  for (const [name, recorded] of Object.entries(evidence.forward_unchanged)) {
    assert.deepEqual(
      generate(recorded),
      recorded.query,
      `${name}: SQL changed`
    );
  }
  for (const [name, recorded] of Object.entries(evidence.cases)) {
    assert.deepEqual(
      generate(recorded),
      recorded.versions.baseline,
      `${name}: working-tree SQL changed`
    );
    assert.deepEqual(factoredCandidate(recorded), recorded.versions.candidate);
  }
  for (const [name, recorded] of Object.entries(evidence.functional_checks)) {
    assert.deepEqual(
      generate(recorded),
      recorded.query,
      `${name}: SQL changed`
    );
  }
  if (!process.argv.includes("--live")) {
    console.log(
      `Verified ${Object.keys(evidence.forward_unchanged).length} unchanged ` +
        `forward queries, ${Object.keys(evidence.cases).length} comparisons ` +
        `and ${
          Object.keys(evidence.functional_checks).length
        } navigation checks.`
    );
    return;
  }
  const client = await connect();
  const report = {
    measured_at: new Date().toISOString(),
    cases: {},
    functional_checks: {},
  };
  try {
    for (const [name, recorded] of Object.entries(evidence.cases)) {
      report.cases[name] = await compare(client, recorded);
      console.error(`Validated comparison ${name}`);
    }
    for (const [name, recorded] of Object.entries(evidence.functional_checks)) {
      report.functional_checks[name] = await checkNavigation(
        client,
        recorded,
        evidence.references[recorded.reference].query
      );
      console.error(`Validated navigation ${name}`);
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
module.exports = {
  generate,
  factoredCandidate,
  connect,
  execute,
  compare,
  checkNavigation,
  settings,
};
