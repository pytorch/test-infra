import rockset from "@rockset/client";
import { ArgumentParser } from "argparse";
import { promises as fs, existsSync } from "fs";
import dotenv from "dotenv";
import path from "path";
import { exit } from "process";
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

// Sanity check. Generally not an issue though since we invoke this file via yarn
if (!existsSync(`./rockset`)) {
  console.error(
    "Please cd to the test-infra/torchci folder before running downloadQueryLambda"
  );
  exit(-1);
}

const parser = new ArgumentParser({
  description: "Download a Rockset query lambda to the repo.",
});

parser.add_argument("workspace", {
  help: "Workspace of the query, like 'commons'",
});
parser.add_argument("query", { help: "name of the query" });
parser.add_argument("version", {
  nargs: "?",
  help: "version hash to download",
});

const args = parser.parse_args();

const client = rockset.default(process.env.ROCKSET_API_KEY);
let qLambda;
if (args.version !== undefined && args.version !== "latest") {
  const res = await client.queryLambdas.getQueryLambdaVersion(
    args.workspace,
    args.query,
    args.version
  );
  qLambda = res.data;
} else {
  const res = await client.queryLambdas.getQueryLambdaTagVersion(
    args.workspace,
    args.query,
    "latest"
  );
  qLambda = res.data.version;
}

const sql = qLambda.sql.query;
const metadata = {
  sql_path: `__sql/${args.query}.sql`,
  default_parameters: qLambda.sql.default_parameters,
  description: qLambda.description ?? "",
};

// Update the sql query and parameters in the lambda.json file
const workspaceDir = `./rockset/${args.workspace}`;

await fs.mkdir(`${workspaceDir}/__sql`, { recursive: true });
await fs.writeFile(`${workspaceDir}/__sql/${args.query}.sql`, sql, "utf8");

const metadaJson = JSON.stringify(metadata, null, 2);
await fs.writeFile(
  `${workspaceDir}/${args.query}.lambda.json`,
  metadaJson,
  "utf8"
);

// Update the version in the prodVersions.json file
const prodVersionsFilePath = `./rockset/prodVersions.json`;

const prodVersions = JSON.parse(
  await fs.readFile(prodVersionsFilePath, "utf8")
);
if (!prodVersions[qLambda.workspace]) {
  prodVersions[qLambda.workspace] = {};
}

prodVersions[qLambda.workspace][qLambda.name] = qLambda.version;

await fs.writeFile(
  prodVersionsFilePath,
  JSON.stringify(prodVersions, null, 2),
  "utf8"
);
