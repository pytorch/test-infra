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
  required: true,
});
parser.add_argument("query", { help: "name of the query", required: true });
parser.add_argument("version", {
  help: "version hash to download",
  required: true,
});

const args = parser.parse_args();

const client = rockset.default(process.env.ROCKSET_API_KEY);
const qLambda = await client.queryLambdas.getQueryLambdaVersion(
  "commons",
  args.query,
  args.version
);

const sql = qLambda.data.sql.query;
const metadata = {
  sql_path: `__sql/${args.query}.sql`,
  default_parameters: qLambda.data.sql.default_parameters,
  description: qLambda.data.description,
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
