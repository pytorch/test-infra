import rockset from "@rockset/client";
import { promises as fs } from "fs";

async function readJSON(path) {
  const rawData = await fs.readFile(path);
  return JSON.parse(rawData);
}

async function pushProdTag(client, queryName, version) {
  console.log(`Tagging that commons.${queryName}:${version} as 'prod'`);
  await client.queryLambdas.createQueryLambdaTag("commons", queryName, {
    version,
    tag_name: "prod",
  });
}

const client = rockset.default(process.env.ROCKSET_API_KEY);

const prodVersions = await readJSON("./rockset/prodVersions.json");
const tasks = Object.entries(prodVersions).map(([queryName, version]) =>
  pushProdTag(client, queryName, version)
);

await Promise.all(tasks);
