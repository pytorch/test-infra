import rockset from "@rockset/client";
import { ArgumentParser } from "argparse";
import { promises as fs } from "fs";
import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

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
await fs.writeFile(
  `./rockset/${args.workspace}/__sql/${args.query}.sql`,
  sql,
  "utf8"
);

const metadaJson = JSON.stringify(metadata, null, 2);
await fs.writeFile(
  `./rockset/${args.workspace}/${args.query}.lambda.json`,
  metadaJson,
  "utf8"
);
