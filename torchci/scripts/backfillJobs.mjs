// GitHub sometimes fails to deliver webhooks, so we get inconsistent data. This
// script backfills workflow jobs that have not been marked completed for a
// suspiciously long time.

import { DynamoDB } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocument } from "@aws-sdk/lib-dynamodb";
import { Octokit, App } from "octokit";
import { createAppAuth } from "@octokit/auth-app";
import rockset from "@rockset/client";
import { request } from "urllib";

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

async function backfillWorkflowJob(
  id,
  repo_name,
  owner,
  dynamo_key,
  skipBackfill
) {
  console.log(`Checking job ${id}`);

  let job = await octokit.rest.actions.getJobForWorkflowRun({
    owner: owner,
    repo: repo_name,
    job_id: id,
  });
  job = job.data;

  if (skipBackfill(job)) {
    console.log(`Skipping backfill for job ${id}`);
    return;
  }

  const payload = job;
  const table = "torchci-workflow-job";

  const thing = {
    TableName: table,
    Item: {
      dynamoKey: dynamo_key,
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
    j.id,
    w.repository.name as repo_name,
    w.repository.owner.login as owner,
    j.dynamoKey as dynamo_key
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

// Await in a loop???
// Yes: when GitHub has outages and fails to deliver webhooks en masse, we can
// get rate limited while trying to backfill. Since backfilling is not
// latency-sensitive, it's fine to just processed them serially to ensure we
// make forward progress.
for (const {
  id,
  repo_name,
  owner,
  dynamo_key,
} of jobsWithNoConclusion.results) {
  // Some jobs just never get marked completed due to bugs in the GHA backend.
  // Just skip them.
  await backfillWorkflowJob(
    id,
    repo_name,
    owner,
    dynamo_key,
    (job) => job.conclusion === null
  );
}
console.log("::endgroup::");

console.log("::group::Backfilling queued jobs...");
// Also try to backfill queued jobs specifically, with a tighter time bound.
// This is so our queue time stats are as accurate as possible.
const queuedJobs = await client.queries.query({
  sql: {
    query: `
SELECT
    j.id,
    w.repository.name as repo_name,
    w.repository.owner.login as owner,
    j.dynamoKey as dynamo_key
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

// See above for why we're awaiting in a loop.
for (const { id, repo_name, owner, dynamo_key } of queuedJobs.results) {
  await backfillWorkflowJob(
    id,
    repo_name,
    owner,
    dynamo_key,
    (job) => job.status === "queued" && job.steps.length === 0
  );
}
console.log("::endgroup::");

console.log("::group::Backfill unclassified logs...");
const unclassifiedJobs = await client.queries.query({
  sql: {
    query: `
select
    j.id,
from
    commons.workflow_job j
    join commons.workflow_run w on w.id = j.run_id
where
    j.torchci_classification is null
    and j.conclusion in ('failure', 'cancelled')
    and PARSE_TIMESTAMP_ISO8601(j.completed_at) > CURRENT_DATETIME() - INTERVAL 30 MINUTE
    and j.name != 'ciflow_should_run'
    and j.name != 'generate-test-matrix'
    and w.event != 'workflow_run'
    and w.event != 'repository_dispatch'
    and w.head_repository.full_name = 'pytorch/pytorch'
`,
  },
});
console.log(
  `There are ${unclassifiedJobs.results.length} jobs with unclassified logs`
);
for (const job of unclassifiedJobs.results) {
  console.log(`Attempting to backfill log of ${job.id}`);
  try {
    const a = await request(
      `https://vwg52br27lx5oymv4ouejwf4re0akoeg.lambda-url.us-east-1.on.aws/?job_id=${job.id}`
    );
    console.log(a);
  } catch (error) {
    console.log(`Failed to backfill log of ${job.id}: ${error}`);
  }
}
console.log("::endgroup::");
