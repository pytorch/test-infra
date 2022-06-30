import rockset from "@rockset/client";
import { promises as fs } from "fs";
import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const client = rockset.default(process.env.ROCKSET_API_KEY);

async function readJSON(path) {
    const rawData = await fs.readFile(path);
    return JSON.parse(rawData);
}
const prodVersions = await readJSON("rockset/prodVersions.json");

const response = await client.queryLambdas.executeQueryLambda(
    "commons",
    "slow_tests",
    prodVersions.commons.slow_tests,
    {}
);

let slowTests = {}
for (const row of response.results) {
    slowTests[row.test_name] = row.avg_duration_sec
}

process.stdout.write(JSON.stringify(slowTests, null, 2))
