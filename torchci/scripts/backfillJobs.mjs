// GitHub sometimes fails to deliver webhooks, so we get inconsistent data. This
// script backfills workflow jobs that have not been marked completed for a
// suspiciously long time.

import { DynamoDB } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocument } from "@aws-sdk/lib-dynamodb";
import { createClient } from "@clickhouse/client";
import { createAppAuth } from "@octokit/auth-app";
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

const privateKey = Buffer.from(process.env.PRIVATE_KEY, "base64").toString();
const app = new App({ appId: process.env.APP_ID, privateKey });

// Jobs come from every repo, possibly in several orgs, and each org has its own
// installation of the app. One client per owner; repos the app cannot reach
// are remembered so they are skipped without asking again.
const octokits = new Map();
const unreachableRepos = new Set();

async function getOctokit(owner, repo) {
  if (octokits.has(owner)) {
    return octokits.get(owner);
  }
  if (unreachableRepos.has(`${owner}/${repo}`)) {
    return null;
  }
  try {
    const installation = await app.octokit.request(
      "GET /repos/{owner}/{repo}/installation",
      { owner, repo }
    );
    const octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: process.env.APP_ID,
        privateKey,
        installationId: installation.data.id,
      },
    });
    octokits.set(owner, octokit);
    return octokit;
  } catch (error) {
    console.log(`App is not installed for ${owner}/${repo}: ${error}`);
    unreachableRepos.add(`${owner}/${repo}`);
    return null;
  }
}

// A job 404 only means the job is gone if the repo itself is visible to us.
const visibleRepos = new Map();

async function isRepoVisible(octokit, owner, repo) {
  const key = `${owner}/${repo}`;
  if (!visibleRepos.has(key)) {
    try {
      await octokit.rest.repos.get({ owner, repo });
      visibleRepos.set(key, true);
    } catch (error) {
      console.log(`Cannot read repo ${key}: ${error}`);
      visibleRepos.set(key, false);
    }
  }
  return visibleRepos.get(key);
}

const dClient = getDynamoClient();
const table = "torchci-workflow-job";

// GitHub no longer has this job, usually because its run was deleted, so the
// final webhook will never come. Without this the job stays 'queued' in
// ClickHouse and sits on the HUD queue panels for a week. Mark it completed
// with no conclusion (we do not know how it ended) and stop backfilling it.
async function markJobGone(id, dynamo_key) {
  const rows = await queryClickhouse(
    `SELECT * FROM workflow_job j final
     WHERE j.dynamoKey = {dynamo_key: String} and j.id = {id: Int64}`,
    { dynamo_key, id }
  );

  if (rows.length === 0) {
    console.log(`No entry found in CH for job id ${id}`);
    return;
  }

  const thing = {
    TableName: table,
    Item: {
      ...rows[0],
      status: "completed",
      data_quality: "gone",
      backfill: false,
    },
  };
  console.log(`Job ${id} is gone from GitHub, marking it completed:`);
  console.log(thing);
  await dClient.put(thing);
}

async function backfillWorkflowJob(
  id,
  repo_name,
  owner,
  dynamo_key,
  skipBackfill
) {
  console.log(`Checking job ${id} in ${owner}/${repo_name}`);

  const octokit = await getOctokit(owner, repo_name);
  if (octokit === null) {
    return;
  }

  let job;
  try {
    job = (
      await octokit.rest.actions.getJobForWorkflowRun({
        owner: owner,
        repo: repo_name,
        job_id: id,
      })
    ).data;
  } catch (error) {
    if (
      error.status === 404 &&
      (await isRepoVisible(octokit, owner, repo_name))
    ) {
      await markJobGone(id, dynamo_key);
    } else {
      // Rate limits and outages are transient, so leave the job to be retried
      // on the next run.
      console.log(`Failed to fetch job ${id}, will retry: ${error}`);
    }
    return;
  }

  if (skipBackfill(job)) {
    console.log(`Skipping backfill for job ${id}`);
    return;
  }

  const thing = {
    TableName: table,
    Item: {
      dynamoKey: dynamo_key,
      ...job,
    },
  };
  console.log(`Writing job ${id} to DynamoDB`);
  console.log(thing);
  await dClient.put(thing);
}

console.log("::group::Backfilling jobs without a conclusion...");

const jobsWithNoConclusion = await queryClickhouse(
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
  `,
  {}
);

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
// This is so our queue time stats are as accurate as possible. Oldest first,
// because those are the ones most likely to have lost their final webhook and
// the ones that distort the queue panels most.
const queuedJobs = await queryClickhouse(
  `with pending_jobs as (
    SELECT
        j.id as id,
        j.run_id as run_id,
        j.dynamoKey as dynamoKey,
        j.started_at as started_at
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
    AND w.id in (select run_id from pending_jobs)
ORDER BY
    j.started_at ASC
LIMIT
    200`,
  {}
);

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
const unclassifiedJobs = await queryClickhouse(
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
