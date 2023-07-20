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
const prodVersionsNew = await readJSON("rockset/prodVersions.json");

function equalParametersList(paramsA, paramsB) {
  const diff = paramsA.find((a) => {
    const b = paramsB.find((b) => b.name == a.name);
    if (!b) {
      return true;
    }
    return a.value != b.value || a.type != b.type;
  });
  return diff === undefined;
}

async function upload(workspace, queryName, queryLambdas) {
  const config = await readJSON(
    `./rockset/${workspace}/${queryName}.lambda.json`
  );
  const query = await fs.readFile(
    `./rockset/${workspace}/__sql/${queryName}.sql`,
    "utf8"
  );

  const queryLambda = queryLambdas
    .get(workspace, new Map())
    .get(queryName, undefined);

  if (!queryLambda) {
    const resCreate = await client.queryLambdas.createQueryLambda(workspace, {
      name: queryName,
      description: config.description,
      sql: {
        query,
        default_parameters: config.default_parameters,
      },
    });
    const newVersion = resCreate.data.version;
    prodVersionsNew[workspace][queryName] = newVersion;
    console.log(`Created ${workspace}.${queryName} to version ${newVersion}`);
    return;
  }

  if (
    queryLambda.description == config.description &&
    equalParametersList(
      queryLambda.default_parameters,
      config.default_parameters
    ) &&
    queryLambda.query == query
  ) {
    console.log(`No change to ${workspace}.${queryName}`);
    return;
  }

  const resUp = await client.queryLambdas.updateQueryLambda(
    workspace,
    queryName,
    {
      description: config.description,
      sql: {
        query,
        default_parameters: config.default_parameters,
      },
    }
  );

  const newVersion = resUp.data.version;
  prodVersionsNew[workspace][queryName] = newVersion;

  console.log(`Updated ${workspace}.${queryName} to version ${newVersion}`);
}

const resListQueryLambdas = await client.queryLambdas.listAllQueryLambdas();
const queryLambdas = new Map();
resListQueryLambdas.data.forEach((queryLambda) => {
  const workspace = queryLambda.workspace;
  const queryName = queryLambda.name;
  if (!queryLambdas.has(workspace)) {
    queryLambdas.set(workspace, new Map());
  }
  queryLambdas.get(workspace).set(queryName, {
    description: queryLambda.latest_version.description,
    default_parameters: queryLambda.latest_version.sql.default_parameters,
    query: queryLambda.latest_version.sql.query,
  });
});

const tasks = [];
Object.keys(prodVersions).forEach((workspace) => {
  Object.entries(prodVersions[workspace]).forEach(([queryName, _]) =>
    tasks.push(upload(workspace, queryName, queryLambdas))
  );
});
await Promise.all(tasks);

await fs.writeFile(
  "rockset/prodVersions.json",
  JSON.stringify(prodVersionsNew, null, 2),
  "utf8"
);
