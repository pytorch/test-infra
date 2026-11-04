// GitHub sometimes fails to deliver webhooks, so we get inconsistent data. This
// script backfills workflow jobs that have not been marked completed for a
// suspiciously long time.
// Usage: node scripts/backfillJobs.mjs [--dry-run] [--limit N]

import { DynamoDB } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocument } from "@aws-sdk/lib-dynamodb";
import { createClient } from "@clickhouse/client";
import { createAppAuth } from "@octokit/auth-app";
import { App, Octokit } from "octokit";
import { request } from "urllib";

const BACKFILL_REPOSITORIES = ["pytorch/pytorch", "pytorch/executorch"];
const DEFAULT_BACKFILL_LIMIT = 200;

function parseArgs() {
  const args = process.argv.slice(2);
  let dryRun = false;
  let backfillLimit = DEFAULT_BACKFILL_LIMIT;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--limit" && i + 1 < args.length) {
      backfillLimit = Number.parseInt(args[++i], 10);
      if (!Number.isInteger(backfillLimit) || backfillLimit <= 0) {
        throw new Error("--limit must be a positive integer");
      }
    } else {
      throw new Error(
        "Usage: node scripts/backfillJobs.mjs [--dry-run] [--limit N]"
      );
    }
  }

  return { dryRun, backfillLimit };
}

const { dryRun, backfillLimit } = parseArgs();

if (dryRun) {
  console.log(`[dry-run] Backfill limit: ${backfillLimit}`);
  console.log(
    `[dry-run] GitHub auth: ${
      process.env.GITHUB_TOKEN ? "token" : "unauthenticated"
    }`
  );
}

function getDynamoClient() {
  return DynamoDBDocument.from(
    new DynamoDB({
      region: "us-east-1",
    })
  );
}

function getClickhouseClient() {
  return createClient({
    url: process.env.CLICKHOUSE_HUD_USER_URL,
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

const dClient = dryRun ? null : getDynamoClient();
const octokitClients = new Map();

async function getOctokitForRepo(owner, repo) {
  if (dryRun) {
    const cacheKey = "dry-run";
    if (!octokitClients.has(cacheKey)) {
      const auth = process.env.GITHUB_TOKEN;
      octokitClients.set(
        cacheKey,
        Promise.resolve(auth ? new Octokit({ auth }) : new Octokit())
      );
    }
    return await octokitClients.get(cacheKey);
  }

  const repository = `${owner}/${repo}`;
  if (!octokitClients.has(repository)) {
    octokitClients.set(repository, getOctokit(owner, repo));
  }
  return await octokitClients.get(repository);
}

async function backfillWorkflowJob(
  id,
  repo_name,
  owner,
  dynamo_key,
  skipBackfill
) {
  console.log(`Checking job ${owner}/${repo_name}#${id}`);

  const table = "torchci-workflow-job";
  const octokit = await getOctokitForRepo(owner, repo_name);

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
    if (dryRun) {
      console.log(`[dry-run] Would write job ${id} to DynamoDB`);
    } else {
      console.log(`Writing job ${id} to DynamoDB`);
      console.log(thing);
      await dClient.put(thing);
    }
  } catch (error) {
    if (error.status !== 404) {
      throw error;
    }
    console.log(`Failed to find job id ${id}: ${error}`);
    console.log(`Marking job id ${id} as incomplete`);
    console.log(`Querying dynamo entry for job id ${id}`);

    let rows = await queryClickhouse(
      `SELECT * FROM workflow_job j final WHERE j.dynamoKey = {dynamoKey: String} and j.id = {id: UInt64}`,
      { dynamoKey: dynamo_key, id }
    );

    if (rows.length === 0) {
      console.log(`No entry found in CH for job id ${id}`);
      return;
    }

    const result = rows[0];

    const thing = {
      TableName: table,
      Item: {
        ...result,
        data_quality: "incomplete",
        backfill: false,
      },
    };
    if (dryRun) {
      console.log(`[dry-run] Would write job ${id} to DynamoDB`);
    } else {
      console.log(`Writing job ${id} to DynamoDB:`);
      console.log(thing);
      await dClient.put(thing);
    }
    return;
  }
}

console.log("::group::Backfilling jobs without a conclusion...");

const jobsWithNoConclusion = await queryClickhouse(
  `with pending_jobs as (
    SELECT
        j.id as id,
        j.run_id as run_id,
        j.dynamoKey as dynamoKey,
        j.repository_full_name as repository_full_name,
        j.started_at as started_at
    FROM
        workflow_job j final
    WHERE
        j.conclusion = ''
        and j.backfill
        and j.repository_full_name in {repositories: Array(String)}
        and j.id in (
            select
                id
            from
                materialized_views.workflow_job_by_started_at
            where
                started_at < CURRENT_TIMESTAMP() - INTERVAL 3 HOUR
                and started_at > CURRENT_TIMESTAMP() - INTERVAL 1 DAY
        )
)
SELECT
    j.id as id,
    w. repository. 'name' as repo_name,
    w. repository. 'owner'.'login' as owner,
    j.dynamoKey as dynamo_key,
    w.repository. 'full_name' as repository_full_name,
    row_number() OVER (
        PARTITION BY w.repository. 'full_name'
        ORDER BY j.started_at ASC
    ) as repository_rank
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
    and w.repository. 'full_name' in {repositories: Array(String)}
ORDER BY
    repository_rank ASC,
    j.started_at ASC
LIMIT
    {backfillLimit: Int64}
  `,
  {
    repositories: BACKFILL_REPOSITORIES,
    backfillLimit,
  }
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
// This is so our queue time stats are as accurate as possible.
const queuedJobs = await queryClickhouse(
  `with pending_jobs as (
    SELECT
        j.id as id,
        j.run_id as run_id,
        j.dynamoKey as dynamoKey,
        j.repository_full_name as repository_full_name,
        j.started_at as started_at
    FROM
        workflow_job j final
    WHERE
        j.status = 'queued'
        and j.backfill
        and j.repository_full_name in {repositories: Array(String)}
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
    j.dynamoKey as dynamo_key,
    w.repository. 'full_name' as repository_full_name,
    row_number() OVER (
        PARTITION BY w.repository. 'full_name'
        ORDER BY j.started_at ASC
    ) as repository_rank
FROM
    workflow_run w final
    INNER JOIN pending_jobs j on j.run_id = w.id
WHERE
    w.status != 'completed'
    AND w.repository. 'full_name' in {repositories: Array(String)}
    AND w.id in (select run_id from pending_jobs)
ORDER BY
    repository_rank ASC,
    j.started_at ASC
LIMIT
    {backfillLimit: Int64}
`,
  {
    repositories: BACKFILL_REPOSITORIES,
    backfillLimit,
  }
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
  if (dryRun) {
    console.log(`[dry-run] Skipping log backfill for ${job.id}`);
    continue;
  }
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
