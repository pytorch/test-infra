// Run from torchci. --live replays the recorded read-only SQL, EXPLAIN plans,
// and alternating complete-row comparisons with the query cache disabled.
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
require.extensions[".ts"] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  });
  module._compile(outputText, filename);
};
const {
  buildRunWorkflowQuery,
} = require("../lib/api/tests/test/runs/workflow-query");
const evidence = JSON.parse(
  fs.readFileSync(
    path.join(root, "lib/api/tests/test/runs/workflow-query-validation.json"),
    "utf8"
  )
);
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function main() {
  const generated = buildRunWorkflowQuery(evidence.job_ids);
  assert.deepEqual(
    generated,
    evidence.versions.after,
    "Working-tree SQL or parameters changed; regenerate and remeasure evidence"
  );
  if (!process.argv.includes("--live")) {
    console.log("Verified the working-tree workflow metadata query.");
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
  async function execute(query, prefix = "", settings = {}) {
    assert(/^\s*(WITH|SELECT)\b/i.test(query.sql), "Expected read-only SQL");
    const response = await client.query({
      query: prefix + query.sql,
      query_params: query.params,
      format: "JSON",
      clickhouse_settings: { ...evidence.settings, ...settings },
    });
    return response.json();
  }
  try {
    const report = {
      measured_at: new Date().toISOString(),
      server: (
        await execute({
          sql: "SELECT version() AS version, currentDatabase() AS database",
          params: {},
        })
      ).data[0],
      settings: evidence.settings,
      job_ids: evidence.job_ids,
      versions: { before: evidence.versions.before, after: generated },
      plans: {},
      samples: [],
    };
    for (const version of ["before", "after"]) {
      report.plans[version] = {};
      for (const plan of ["indexes=1", "PIPELINE"]) {
        report.plans[version][plan] = (
          await execute(report.versions[version], `EXPLAIN ${plan} `)
        ).data.map((row) => row.explain);
      }
    }
    let reference;
    for (let pair = 0; pair < 8; pair++) {
      const order = pair % 2 ? ["after", "before"] : ["before", "after"];
      for (const version of order) {
        const response = await execute(report.versions[version]);
        const rows = response.data.sort((a, b) =>
          a.github_workflow_job_id.localeCompare(b.github_workflow_job_id)
        );
        assert(rows.length > 0, "Fixture expired or empty");
        reference ??= rows;
        assert.deepEqual(
          rows,
          reference,
          `Rows differ: pair ${pair}, ${version}`
        );
        report.samples.push({
          pair,
          version,
          rows: response.rows,
          statistics: response.statistics,
          digest: digest(rows),
        });
      }
    }
    report.result_rows = reference;
    const override = await execute(generated, "", {
      output_format_json_named_tuples_as_objects: 0,
    });
    const overrideRows = override.data.sort((a, b) =>
      a.github_workflow_job_id.localeCompare(b.github_workflow_job_id)
    );
    const prs = overrideRows.flatMap((row) => row.workflow_pull_requests);
    assert(prs.length > 0, "Fixture must include a recorded PR association");
    assert(
      prs.every((pr) => !Array.isArray(pr) && typeof pr.number === "number"),
      "SQL must serialize named PR tuples as objects despite the client setting"
    );
    assert.deepEqual(
      overrideRows,
      reference,
      "Client tuple setting changed rows"
    );
    report.named_tuple_override = {
      client_setting: 0,
      sql_setting: 1,
      rows: override.rows,
      statistics: override.statistics,
      digest: digest(overrideRows),
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await client.close();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
