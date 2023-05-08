import rockset from "@rockset/client";
import { promises as fs } from "fs";
import dotenv from "dotenv";
import path from "path";
import _ from "lodash";
import { request } from "urllib";

async function getTestTimes(numRetries = 3) {
  for (let i = 0; i < numRetries; i++) {
    let result = await request(
      "https://raw.githubusercontent.com/pytorch/test-infra/generated-stats/stats/test-times.json"
    );

    if (result.res.statusCode == 200) {
      return JSON.parse(result.data);
    }
  }
  throw new Error("failed to retrieve old test times");
}

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const client = rockset.default(process.env.ROCKSET_API_KEY);

async function readJSON(path) {
  const rawData = await fs.readFile(path);
  return JSON.parse(rawData);
}

const prodVersions = await readJSON("rockset/prodVersions.json");

const response = await client.queryLambdas.executeQueryLambda(
  "commons",
  "test_time_per_file",
  prodVersions.commons.test_time_per_file,
  {}
);

const periodic = await client.queryLambdas.executeQueryLambda(
  "commons",
  "test_time_per_file_periodic_jobs",
  prodVersions.commons.test_time_per_file_periodic_jobs,
  {}
);

let testTimes = await getTestTimes();
for (const row of periodic.results.concat(response.results)) {
  _.set(
    testTimes,
    `["${row.base_name}"]["${row.test_config}"]["${row.file}"]`,
    row.time
  );
}

process.stdout.write(JSON.stringify(testTimes, null, 2));
