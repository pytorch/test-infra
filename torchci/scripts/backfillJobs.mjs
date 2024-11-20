// GitHub sometimes fails to deliver webhooks, so we get inconsistent data. This
// script backfills workflow jobs that have not been marked completed for a
// suspiciously long time.

import { DynamoDB } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocument } from "@aws-sdk/lib-dynamodb";
import { createClient } from "@clickhouse/client";
import { createAppAuth } from "@octokit/auth-app";
import rockset from "@rockset/client";
import { App, Octokit } from "octokit";
import { request } from "urllib";

function getDynamoClient() {
  return DynamoDBDocument.from(
    new DynamoDB({
      region: "us-east-1",
    })
  );
}

function getClickhouseClient() {
  return createClient({
    host: process.env.CLICKHOUSE_HUD_USER_URL,
    username: process.env.CLICKHOUSE_HUD_USER_USERNAME,
    password: process.env.CLICKHOUSE_HUD_USER_PASSWORD,
  });
}

export async function queryClickhouse(query, params) {
  const clickhouseClient = getClickhouseClient();
  const res = await clickhouseClient.query({
    query,
    format: "JSONEachRow",
    query_params: params,
    clickhouse_settings: { output_format_json_quote_64bit_integers: 0 },
  });

  return await res.json();
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

  const table = "torchci-workflow-job";

  try {
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
  } catch (error) {
    console.log(`Failed to find job id ${id}: ${error}`);
    console.log(`Marking job id ${id} as incomplete`);
    console.log(`Querying dynamo entry for job id ${id}`);

    let rows = await queryClickhouse(
      `SELECT * FROM workflow_job j final WHERE j.dynamoKey = '${dynamo_key}' and j.id = ${id}`,
      {}
    );

    if (rows.length === 0) {
      console.log(`No entry found in CH for job id ${id}`);
      rows = (
        await client.queries.query({
          sql: {
            query: `
SELECT
    *
FROM
    workflow_job j
WHERE
    j.dynamoKey = '${dynamo_key}'
`,
          },
        })
      ).results;
    }

    if (rows.length === 0) {
      console.log(`No entry found in Rockset for job id ${id}`);
      return;
    }

    const result = rows[0];

    console.log(`Writing job ${id} to DynamoDB:`);
    const thing = {
      TableName: table,
      Item: {
        ...result,
        data_quality: "incomplete",
        backfill: false,
      },
    };
    console.log(thing);
    await dClient.put(thing);
    return;
  }
}

console.log("::group::Backfilling jobs without a conclusion...");
const jobsWithNoConclusion = (
  await client.queries.query({
    sql: {
      query: `
SELECT
    j.id,
    w.repository.name as repo_name,
    w.repository.owner.login as owner,
    j.dynamoKey as dynamo_key,
FROM
    workflow_job j
    INNER JOIN workflow_run w on j.run_id = w.id
WHERE
    j.conclusion IS NULL
    AND PARSE_TIMESTAMP_ISO8601(j.started_at) < (CURRENT_TIMESTAMP() - INTERVAL 3 HOUR)
    AND PARSE_TIMESTAMP_ISO8601(j.started_at) > (CURRENT_TIMESTAMP() - INTERVAL 1 DAY)
    AND w.repository.name = 'pytorch'
    AND j.backfill IS NULL
ORDER BY
    j._event_time ASC
LIMIT 200
`,
    },
  })
).results;

const chJobsWithNoConclusion = await queryClickhouse(
  `with pending_jobs as (
    SELECT
        j.id as id,
        j.run_id as run_id,
        j.dynamoKey as dynamoKey
    FROM
        workflow_job j final
    WHERE
        j.conclusion = ''
        and j.backfill
        and j.id in (
            select
                id
            from
                materialized_views.workflow_job_by_started_at
            where
                started_at < CURRENT_TIMESTAMP() - INTERVAL 3 HOUR
                and started_at > CURRENT_TIMESTAMP() - INTERVAL 1 DAY
        )
    ORDER BY
        j.started_at ASC
    LIMIT
        200
)
SELECT
    j.id as id,
    w. repository. 'name' as repo_name,
    w. repository. 'owner'.'login' as owner,
    j.dynamoKey as dynamo_key
FROM
    workflow_run w final
    INNER JOIN pending_jobs j on j.run_id = w.id
WHERE
    w.id in (
        select
            run_id
        from
            pending_jobs
    )
    and w.repository. 'name' = 'pytorch'
  `,
  {}
);
// Add jobs that CH found but Rockset didn't
for (const job of chJobsWithNoConclusion) {
  const { dynamo_key } = job;
  if (jobsWithNoConclusion.find((job) => job.dynamo_key === dynamo_key)) {
    continue;
  } else {
    jobsWithNoConclusion.push(job);
  }
}

// Await in a loop???
// Yes: when GitHub has outages and fails to deliver webhooks en masse, we can
// get rate limited while trying to backfill. Since backfilling is not
// latency-sensitive, it's fine to just processed them serially to ensure we
// make forward progress.
for (const { id, repo_name, owner, dynamo_key } of jobsWithNoConclusion) {
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
const queuedJobs = (
  await client.queries.query({
    sql: {
      query: `
SELECT
    j.id,
    w.repository.name as repo_name,
    w.repository.owner.login as owner,
    j.dynamoKey as dynamo_key,
FROM
    workflow_job j
    INNER JOIN workflow_run w on j.run_id = w.id
WHERE
    j.status = 'queued'
    AND w.status != 'completed'
    AND PARSE_TIMESTAMP_ISO8601(j.started_at) < (CURRENT_TIMESTAMP() - INTERVAL 5 MINUTE)
    AND PARSE_TIMESTAMP_ISO8601(j.started_at) > (CURRENT_TIMESTAMP() - INTERVAL 7 DAY)
    AND w.repository.name = 'pytorch'
    AND j.backfill IS NULL
ORDER BY
    j._event_time ASC
LIMIT 200
`,
    },
  })
).results;
const chQueuedJobs = await queryClickhouse(
  `with pending_jobs as (
    SELECT
        j.id as id,
        j.run_id as run_id,
        j.dynamoKey as dynamoKey
    FROM
        workflow_job j final
    WHERE
        j.status = 'queued'
        and j.backfill
        and j.id in (
            select
                id
            from
                materialized_views.workflow_job_by_started_at
            where
                started_at < CURRENT_TIMESTAMP() - INTERVAL 5 MINUTE
                and started_at > CURRENT_TIMESTAMP() - INTERVAL 7 DAY
        )
)
SELECT
    j.id as id,
    w.repository. 'name' as repo_name,
    w.repository. 'owner'.'login' as owner,
    j.dynamoKey as dynamo_key
FROM
    workflow_run w final
    INNER JOIN pending_jobs j on j.run_id = w.id
WHERE
    w.status != 'completed'
    AND w.repository. 'name' = 'pytorch'
    AND w.id in (select run_id from pending_jobs)
LIMIT
    200`,
  {}
);
// Add jobs that CH found but Rockset didn't
for (const job of chQueuedJobs) {
  const { dynamo_key } = job;
  if (queuedJobs.find((job) => job.dynamo_key === dynamo_key)) {
    continue;
  } else {
    queuedJobs.push(job);
  }
}

// See above for why we're awaiting in a loop.
for (const { id, repo_name, owner, dynamo_key } of queuedJobs) {
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
const unclassifiedJobs = (
  await client.queries.query({
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
    AND j.backfill IS NULL
`,
    },
  })
).results;
const chUnclassifiedJobs = await queryClickhouse(
  `with jobs as (
    select
        j.id as id,
        j.run_id as run_id
    from
        default .workflow_job j final
    where
        j.torchci_classification.line = ''
        and j.backfill
        and j.conclusion in [ 'failure',
        'cancelled' ]
        and j.name != 'ciflow_should_run'
        and j.name != 'generate-test-matrix'
        and j.completed_at > now() - Interval 30 MINUTE
        and j.completed_at < now() - Interval 5 MINUTE
)
select
    j.id as id
from
    default .workflow_run w final
    join jobs j on w.id = j.run_id
where
    w.event != 'workflow_run'
    and w.event != 'repository_dispatch'
    and w.head_repository. 'full_name' = 'pytorch/pytorch'
    and w.id in (
        select
            run_id
        from
            jobs
    )`,
  {}
);
// Add jobs that CH found but Rockset didn't
for (const job of chUnclassifiedJobs) {
  const { id } = job;
  if (unclassifiedJobs.find((job) => job.id === id)) {
    continue;
  } else {
    unclassifiedJobs.push(job);
  }
}

console.log(`There are ${unclassifiedJobs.length} jobs with unclassified logs`);
for (const job of unclassifiedJobs) {
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
