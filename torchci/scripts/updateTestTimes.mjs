import rockset from "@rockset/client";
import { promises as fs } from "fs";
import dotenv from "dotenv";
import path from "path";
import _ from "lodash";

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

let ret = {};
for (const row of periodic.results.concat(response.results)) {
  _.set(
    ret,
    `["${row.base_name}"]["${row.test_config}"]["${row.file}"]`,
    row.time
  );
}

process.stdout.write(JSON.stringify(ret, null, 2));
