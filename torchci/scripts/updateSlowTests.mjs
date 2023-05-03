import rockset from "@rockset/client";
import dotenv from "dotenv";
import { promises as fs } from "fs";
import path from "path";
import _ from "lodash";

async function readJSON(path) {
  const rawData = await fs.readFile(path);
  return JSON.parse(rawData);
}

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const client = rockset.default(process.env.ROCKSET_API_KEY);
const prodVersions = await readJSON("rockset/prodVersions.json");

const workflowsQuery = `
select
    DISTINCT w.name
from
    commons.workflow_run w
    join commons.workflow_job j on j.run_id = w.id
where
    w._event_time > CURRENT_TIMESTAMP() - DAYS(7)
    and w.head_branch = 'main'
    and j.name like '%test%'
`;

const workflows = await client.queries.query({
  sql: {
    query: workflowsQuery,
  },
});

const results = await Promise.all(
  workflows.results.map((val) =>
    client.queryLambdas.executeQueryLambda(
      "commons",
      "slow_tests_by_workflow",
      prodVersions.commons.slow_tests_by_workflow,
      {
        parameters: [
          {
            name: "workflow",
            type: "string",
            value: val["name"],
          },
        ],
      }
    )
  )
);

let slowTests = {};

for (const workflow of results) {
  for (const row of workflow.results) {
    _.set(
      slowTests,
      `["${row.base_name}"]["${row.test_name}"]`,
      row.avg_duration_sec
    );
  }
}

process.stdout.write(JSON.stringify(slowTests, null, 2));
