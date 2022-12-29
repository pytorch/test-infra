import rockset from "@rockset/client";
import { promises as fs } from "fs";

async function readJSON(path) {
  const rawData = await fs.readFile(path);
  return JSON.parse(rawData);
}

async function pushProdTag(client, workspace, queryName, version) {
  const currentRocksetVersion = await client.queryLambdas.getQueryLambdaTagVersion(
    workspace,
    queryName,
    "prod"
  );
  if (currentRocksetVersion.data.version.version == version) {
    console.log(
      `${workspace}.${queryName}:${version} already tagged as 'prod'`
    );
  } else {
    await client.queryLambdas.createQueryLambdaTag(workspace, queryName, {
      version,
      tag_name: "prod",
    });
    console.log(`Tagged that ${workspace}.${queryName}:${version} as 'prod'`);
  }
}

const client = rockset.default(process.env.ROCKSET_API_KEY);

const prodVersions = await readJSON("./rockset/prodVersions.json");
const tasks = [];
Object.keys(prodVersions).forEach((workspace) => {
  Object.entries(prodVersions[workspace]).forEach(([queryName, version]) =>
    tasks.push(pushProdTag(client, workspace, queryName, version))
  );
});

await Promise.all(tasks);
