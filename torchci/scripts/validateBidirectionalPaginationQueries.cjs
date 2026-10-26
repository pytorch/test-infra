// From torchci, use Node 22. Without --live, verify the recorded SQL still
// matches the working tree. --live repeats plans, alternating comparisons,
// forward/backward row checks and one-row boundary probes against the
// recorded bundle. --record rebuilds the bundle from the fixtures below: it
// reads each reference page live, derives every cursor from its rows,
// generates the SQL from the working tree, runs the live checks and writes
// the file.
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
const { CI_DATABASE } = require("lib/api/tests/database");
const evidencePath = path.join(
  root,
  "lib/api/tests/validation/bidirectional-pagination-2026-10-26.json"
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

// The fixed nonempty requests the bundle is recorded from: each a forward
// first page, the reference, whose rows at the anchors below give the cursors
// of every page derived from it. The tests fixtures pin the window, so a
// change of the list's default leaves them as they are.
const REPOSITORY = "pytorch/pytorch";
const COMMIT = "9cc78e09ce3ea174d43897d70a5fea93d8caa34c";
const PAGE_LIMIT = "3";
const FIXTURES = [
  {
    name: "tests_metrics",
    kind: "tests",
    raw: {
      repo: REPOSITORY,
      window: "7d",
      file: "test/test_torch.py",
      sort: "failure_rate,-runs",
    },
    referenceLimit: "12",
    probes: true,
  },
  {
    name: "tests_null_boundary",
    kind: "tests",
    raw: {
      repo: REPOSITORY,
      window: "7d",
      file: ["test/test_torch.py", "cpp/op_registration_test"],
      case_name: [
        "test_RNGState",
        "AutogradBackendOverridesAutogradKernel",
        "AutogradBackendOverridesCompositeImplicitAutogradKernel",
        "AutogradXLAOverridesAutogradKernel",
      ],
      sort: "owner,case_name",
    },
    referenceLimit: "100",
    // Enumerated whole; the anchors sit at its end, among the rows with a
    // null owner, and one probe reads past its last row.
    nullBoundary: true,
  },
  {
    name: "test_started",
    kind: "test",
    raw: { test_id: "16960517567045431281", sort: "started_at" },
    referenceLimit: "12",
    probes: true,
  },
  {
    name: "test_null",
    kind: "test",
    raw: { test_id: "2916768648938826", sort: "owner,-started_at" },
    referenceLimit: "12",
  },
  {
    name: "test_last_attempt",
    kind: "test",
    raw: {
      test_id: "16960517567045431281",
      sort: "owner,-started_at",
      last_attempt_outcome: ["failed", "passed"],
    },
    referenceLimit: "12",
  },
  {
    name: "commit_started",
    kind: "commit",
    raw: { repo: REPOSITORY, sha: COMMIT, sort: "started_at" },
    referenceLimit: "12",
    probes: true,
  },
  {
    name: "commit_catalog",
    kind: "commit",
    raw: { repo: REPOSITORY, sha: COMMIT, sort: "owner,-started_at" },
    referenceLimit: "12",
  },
];
// The builders whose text the bundle hashes, so a reader can tell which
// code recorded it, and the tables whose DDL it keeps.
const SOURCE_FILES = [
  "lib/api/tests/query.ts",
  "lib/api/tests/test/runs/query.ts",
  "lib/api/tests/commit/query.ts",
];
const DDL_TABLES = [
  "runs",
  "health",
  "tests",
  "environments",
  "env_vars",
  "owners",
];

// A row's sort key values, sort_0 onward, as a cursor carries them.
function sortValues(row) {
  return Object.keys(row)
    .filter((key) => /^sort_\d+$/.test(key))
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
    .map((key) => row[key]);
}

// The pages derived from a fixture's reference rows: the unchanged forward
// pages, the previous-page comparisons and the navigation checks, each with
// the slice of the reference it must return. A standard fixture anchors at
// row 8 of its 13; the null-boundary fixture at its second-to-last row. A
// previous page of limit L returns the L + 1 rows before the anchor, a next
// page the L + 1 after it, and a probe (limitOverride 0) one row.
function derivedEntries(fixture, rows) {
  const { name, kind } = fixture;
  const length = rows.length;
  const anchor = fixture.nullBoundary ? length - 2 : 8;
  assert(
    anchor >= 4 && anchor < length,
    `${name}: ${length} reference rows are too few to anchor pages in`
  );
  const raw = (limit) => ({ ...fixture.raw, limit });
  const at = (index, direction) => ({
    ...(direction ? { direction } : {}),
    position: { values: sortValues(rows[index]) },
  });
  const before = (index, limit) => [Math.max(index - (limit + 1), 0), index];
  const after = (index, limit) => [
    index + 1,
    Math.min(index + limit + 2, length),
  ];
  const entry = (limit, cursor, extra = {}) => ({
    kind,
    raw: raw(limit),
    ...(cursor ? { cursor } : {}),
    ...extra,
  });
  const check = (limit, cursor, range, extra = {}) => ({
    ...entry(limit, cursor, extra),
    reference: name,
    start: range[0],
    end: range[1],
  });
  const forward = {
    [`${name}_first`]: entry(fixture.referenceLimit),
    [`${name}_next`]: entry(PAGE_LIMIT, at(anchor, "next")),
    [`${name}_legacy`]: entry(PAGE_LIMIT, at(anchor)),
  };
  const cases = { [name]: entry(PAGE_LIMIT, at(anchor, "previous")) };
  const checks = {
    [`${name}_previous`]: check(
      PAGE_LIMIT,
      at(anchor, "previous"),
      before(anchor, 3)
    ),
    [`${name}_previous_changed_limit`]: check(
      "2",
      at(anchor, "previous"),
      before(anchor, 2)
    ),
    [`${name}_previous_boundary_empty`]: check(
      PAGE_LIMIT,
      at(0, "previous"),
      [0, 0]
    ),
    [`${name}_next`]: check(PAGE_LIMIT, at(anchor, "next"), after(anchor, 3)),
  };
  if (fixture.probes) {
    cases[`${name}_probe`] = entry(PAGE_LIMIT, at(anchor, "previous"), {
      limitOverride: 0,
    });
    checks[`${name}_probe_previous`] = check(
      PAGE_LIMIT,
      at(anchor, "previous"),
      before(anchor, 0),
      { limitOverride: 0 }
    );
    checks[`${name}_probe_next`] = check(
      PAGE_LIMIT,
      at(anchor, "next"),
      after(anchor, 0),
      { limitOverride: 0 }
    );
  }
  if (fixture.nullBoundary) {
    checks[`${name}_end_probe_empty`] = check(
      "1",
      at(length - 1, "next"),
      [length, length],
      { limitOverride: 0 }
    );
  }
  return { forward, cases, checks };
}

// Rebuilds the bundle: the references read live, every derived page's SQL
// from the working tree, then the same comparisons and navigation checks
// --live runs, written together with the server, DDL and source hashes.
async function record() {
  const client = await connect();
  const measuredAt = new Date().toISOString();
  try {
    const serverVersion = (
      await execute(client, { sql: "SELECT version() AS version", params: {} })
    ).data[0].version;
    const ddl = {};
    for (const table of DDL_TABLES) {
      const response = await client.query({
        query: `SHOW CREATE TABLE ${CI_DATABASE}.${table}`,
        format: "JSON",
        clickhouse_settings: settings,
      });
      ddl[`${CI_DATABASE}.${table}`] = await response.json();
    }
    const references = {};
    const forwardUnchanged = {};
    const cases = {};
    const functionalChecks = {};
    for (const fixture of FIXTURES) {
      const reference = {
        kind: fixture.kind,
        raw: { ...fixture.raw, limit: fixture.referenceLimit },
      };
      reference.query = generate(reference);
      reference.rows = (await execute(client, reference.query)).data;
      references[fixture.name] = reference;
      const derived = derivedEntries(fixture, reference.rows);
      for (const [name, entry] of Object.entries(derived.forward)) {
        forwardUnchanged[name] = { ...entry, query: generate(entry) };
      }
      for (const [name, entry] of Object.entries(derived.cases)) {
        cases[name] = {
          ...entry,
          versions: {
            baseline: generate(entry),
            candidate: factoredCandidate(entry),
          },
        };
      }
      for (const [name, entry] of Object.entries(derived.checks)) {
        functionalChecks[name] = { ...entry, query: generate(entry) };
      }
      console.error(
        `Recorded ${fixture.name}: ${reference.rows.length} reference rows`
      );
    }
    for (const [name, recorded] of Object.entries(cases)) {
      Object.assign(recorded, await compare(client, recorded));
      console.error(`Validated comparison ${name}`);
    }
    for (const [name, recorded] of Object.entries(functionalChecks)) {
      Object.assign(
        recorded,
        await checkNavigation(
          client,
          recorded,
          references[recorded.reference].query
        )
      );
      console.error(`Validated navigation ${name}`);
    }
    const evidence = {
      measured_at: measuredAt,
      database: CI_DATABASE,
      server_version: serverVersion,
      settings,
      ddl,
      source_hashes: Object.fromEntries(
        SOURCE_FILES.map((file) => [
          file,
          {
            working_tree: createHash("sha256")
              .update(fs.readFileSync(path.join(root, file)))
              .digest("hex"),
          },
        ])
      ),
      optimization:
        "Factor repeated cursor equality prefixes; retain functional baseline unless improvement exceeds noise.",
      forward_unchanged: forwardUnchanged,
      cases,
      functional_checks: functionalChecks,
      completed_at: new Date().toISOString(),
      references,
    };
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
    console.error(`Wrote ${path.relative(root, evidencePath)}`);
  } finally {
    await client.close();
  }
}

async function main() {
  if (process.argv.includes("--record")) return record();
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
  derivedEntries,
  record,
  settings,
};
