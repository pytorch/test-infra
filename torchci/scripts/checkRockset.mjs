import rockset from "@rockset/client";
import { promises as fs } from "fs";
import { diffLines } from "diff";
import "colors";

async function readJSON(path) {
  const rawData = await fs.readFile(path);
  return JSON.parse(rawData);
}

function printDiff(first, second) {
  diffLines(first, second).forEach((part) => {
    const color = part.added ? "green" : part.removed ? "red" : "grey";
    const prefix = part.added ? "+ " : part.removed ? "- " : "  ";
    part.value.split("\n").forEach((line) => {
      process.stderr.write(prefix[color] + line[color] + "\n");
    });
  });
}

async function checkQuery(client, queryName, version) {
  console.log(
    `Checking that commons.${queryName}:${version} is matches your local checkout`
  );
  const qLambda = await client.queryLambdas.getQueryLambdaVersion(
    "commons",
    queryName,
    version
  );
  let passesCheck = true;

  // Check that the query SQL matches the local checkout.
  const remoteQuery = qLambda.data.sql.query;
  const localQuery = await fs.readFile(
    `./rockset/commons/__sql/${queryName}.sql`,
    "utf8"
  );
  if (remoteQuery !== localQuery) {
    console.log(
      `::error::commons.${queryName}:${version} SQL does not match your local checkout. Run 'yarn node scripts/downloadQueryLambda.mjs commons ${queryName} ${version}' to overwrite your local checkout.`
    );
    printDiff(remoteQuery, localQuery);
    passesCheck = false;
  }

  // Check that the query config matches the local checkout.
  const localConfig = await readJSON(
    `./rockset/commons/${queryName}.lambda.json`
  );

  const remoteParams = JSON.stringify(
    qLambda.data.sql.default_parameters,
    null,
    2
  );
  const localParams = JSON.stringify(localConfig.default_parameters, null, 2);
  if (remoteParams !== localParams) {
    console.log(
      `::error::commons.${queryName}:${version} config does not match your local checkout. Run 'yarn node scripts/downloadQueryLambda.mjs commons ${queryName} ${version}' to overwrite your local checkout.`
    );
    printDiff(remoteParams, localParams);
    passesCheck = false;
  }
  return passesCheck;
}

// NOTE: This is a special token with highly restricted access to Rockset. It
// can only be used to list resources. It is intended for use by the CI system only.
const client = rockset.default(
  "4td9ejgZWF4HERUmZufILSn9kQbixwX1FwR9CiJmTkWaXbVNi90eeyfgP7dO2BZP"
);

const prodVersions = await readJSON("./rockset/prodVersions.json");
const checks = Object.entries(prodVersions).map(([queryName, version]) =>
  checkQuery(client, queryName, version)
);

const checkStatuses = await Promise.all(checks);

if (checkStatuses.some((status) => status === false)) {
  process.exit(1);
}
