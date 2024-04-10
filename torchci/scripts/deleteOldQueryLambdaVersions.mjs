// Script to delete old versions of query lambdas

import rockset from "@rockset/client";
import { promises as fs } from "fs";

const oneMonthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

async function readJSON(path) {
  const rawData = await fs.readFile(path);
  return JSON.parse(rawData);
}

const client = rockset.default(process.env.ROCKSET_API_KEY);

const prodVersions = await readJSON("./rockset/prodVersions.json");
Object.keys(prodVersions).forEach((workspace) => {
  Object.entries(prodVersions[workspace]).forEach(
    async ([queryName, jsonVersion]) => {
      const versions = await client.queryLambdas.listQueryLambdaVersions(
        workspace,
        queryName
      );
      const prodVersion = (
        await client.queryLambdas.getQueryLambdaTagVersion(
          workspace,
          queryName,
          "prod"
        )
      ).data.version.version;
      const latest = (
        await client.queryLambdas.getQueryLambdaTagVersion(
          workspace,
          queryName,
          "latest"
        )
      ).data.version.version;

      for (const versionInfo of versions.data) {
        const version = versionInfo.version;
        const lastExecutedAt = versionInfo.last_executed_at;
        const createdAt = versionInfo.created_at;
        if (
          Date.parse(lastExecutedAt) > oneMonthAgo ||
          Date.parse(createdAt) > oneMonthAgo
        ) {
          console.log(
            `Skipping ${workspace}.${queryName}:${version} because it was executed or created recently`
          );
          continue;
        }

        if (
          version == prodVersion ||
          version == latest ||
          version == jsonVersion
        ) {
          console.log(
            `Skipping ${workspace}.${queryName}:${version} because it is tagged as 'prod', 'latest', or in prodVersions.json`
          );
          continue;
        }
        console.log(`Deleting ${workspace}.${queryName}:${version}`);
        await client.queryLambdas.deleteQueryLambdaVersion(
          workspace,
          queryName,
          version
        );
      }
    }
  );
});
