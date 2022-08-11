// GitHub sometimes fails to deliver webhooks, so we get inconsistent data. This
// script backfills workflow jobs that have not been marked completed for a
// suspiciously long time.

import { DynamoDB } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocument } from "@aws-sdk/lib-dynamodb";
import { Octokit, App } from "octokit";
import { createAppAuth } from "@octokit/auth-app";
import rockset from "@rockset/client";

function getDynamoClient() {
  return DynamoDBDocument.from(
    new DynamoDB({
      credentials: {
        accessKeyId: process.env.OUR_AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.OUR_AWS_SECRET_ACCESS_KEY,
      },
      region: "us-east-1",
    })
  );
}

async function getOctokit(owner, repo) {
  let privateKey = process.env.PRIVATE_KEY;
  privateKey = Buffer.from(privateKey, "base64").toString();

  const app = new App({
    appId: process.env.APP_ID,
    privateKey,
  });
  const installation = await app.octokit.request(
    "GET /repos/{owner}/{repo}/installation",
    { owner, repo }
  );

  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: process.env.APP_ID,
      privateKey,
      installationId: installation.data.id,
    },
  });
}

const client = rockset.default(process.env.ROCKSET_API_KEY);
const dClient = getDynamoClient();
const octokit = await getOctokit("pytorch", "pytorch");

async function backfillWorkflowJob(id, skipBackfill) {
  console.log(`Checking job ${id}`);
  // There is the chance that job ids from different repos could collide. To
  // prevent this, prefix the object key with the repo that they come from.
  const key_prefix = "pytorch/pytorch/";

  let job = await octokit.rest.actions.getJobForWorkflowRun({
    owner: "pytorch",
    repo: "pytorch",
    job_id: id,
  });
  job = job.data;

  if (skipBackfill(job)) {
    console.log(`Skipping backfill for job ${id}`);
    return;
  }

  const key = `${key_prefix}${job.id}`;
  const payload = job;
  const table = "torchci-workflow-job";

  const thing = {
    TableName: table,
    Item: {
      dynamoKey: key,
      ...payload,
    },
  };
  console.log(`Writing job ${id} to DynamoDB`);
  console.log(thing);
  await dClient.put(thing);
}

console.log("::group::Backfilling jobs without a conclusion...");
const jobsWithNoConclusion = await client.queries.query({
  sql: {
    query: `
SELECT
    j.id
FROM
    workflow_job j
    INNER JOIN workflow_run w on j.run_id = w.id
WHERE
    j.conclusion IS NULL
    AND PARSE_TIMESTAMP_ISO8601(j.started_at) < (CURRENT_TIMESTAMP() - INTERVAL 3 HOUR)
    AND PARSE_TIMESTAMP_ISO8601(j.started_at) > (CURRENT_TIMESTAMP() - INTERVAL 1 DAY)
    AND w.repository.name = 'pytorch'
ORDER BY
    j._event_time DESC
LIMIT 10000
`,
  },
});

let ids = jobsWithNoConclusion.results.map((r) => r.id);

// Await in a loop???
// Yes: when GitHub has outages and fails to deliver webhooks en masse, we can
// get rate limited while trying to backfill. Since backfilling is not
// latency-sensitive, it's fine to just processed them serially to ensure we
// make forward progress.
for (const id of ids) {
  // Some jobs just never get marked completed due to bugs in the GHA backend.
  // Just skip them.
  await backfillWorkflowJob(id, (job) => job.conclusion === null);
}
console.log("::endgroup::");

console.log("::group::Backfilling queued jobs...");
// Also try to backfill queued jobs specifically, with a tighter time bound.
// This is so our queue time stats are as accurate as possible.
const queuedJobs = await client.queries.query({
  sql: {
    query: `
SELECT
    j.id
FROM
    workflow_job j
    INNER JOIN workflow_run w on j.run_id = w.id
WHERE
    j.status = 'queued'
    AND w.status != 'completed'
    AND PARSE_TIMESTAMP_ISO8601(j.started_at) < (CURRENT_TIMESTAMP() - INTERVAL 5 MINUTE)
    AND w.repository.name = 'pytorch'
ORDER BY
    j._event_time DESC
LIMIT 10000
`,
  },
});

ids = queuedJobs.results.map((r) => r.id);

// See above for why we're awaiting in a loop.
for (const id of ids) {
  await backfillWorkflowJob(id, (job) => job.status === "queued");
}
console.log("::endgroup::");
