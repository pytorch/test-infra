// Cancel GitHub Actions workflow runs with jobs stuck in the queue too long.
// Usage: node scripts/cancelQueuedJobs.mjs [--hours N] [--dry-run]
//
// Requires env vars: APP_ID, PRIVATE_KEY (base64), HUD_API_TOKEN

import { createAppAuth } from "@octokit/auth-app";
import { App, Octokit } from "octokit";

const QUEUED_JOBS_URL =
  "https://hud.pytorch.org/api/clickhouse/queued_jobs?parameters=%7B%7D";
const DEFAULT_THRESHOLD_HOURS = 8;
const OWNER = "pytorch";
const REPO = "pytorch";

function parseArgs() {
  const args = process.argv.slice(2);
  let thresholdHours = DEFAULT_THRESHOLD_HOURS;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--hours" && i + 1 < args.length) {
      thresholdHours = parseFloat(args[++i]);
      if (isNaN(thresholdHours) || thresholdHours <= 0) {
        console.error("Error: --hours must be a positive number");
        process.exit(1);
      }
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    } else {
      console.error(`Unknown argument: ${args[i]}`);
      console.error(
        "Usage: node scripts/cancelQueuedJobs.mjs [--hours N] [--dry-run]"
      );
      process.exit(1);
    }
  }

  return { thresholdHours, dryRun };
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

async function fetchQueuedJobs() {
  console.log("Fetching queued jobs from HUD API...");
  const response = await fetch(QUEUED_JOBS_URL, {
    headers: {
      "x-hud-internal-bot": process.env.HUD_API_TOKEN,
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch queued jobs: HTTP ${response.status}`);
  }
  return response.json();
}

function extractRunId(htmlUrl) {
  const match = htmlUrl.match(/\/actions\/runs\/(\d+)/);
  return match ? match[1] : null;
}

function filterAndDedup(jobs, thresholdHours) {
  const thresholdSeconds = thresholdHours * 3600;
  const longQueued = jobs.filter((job) => job.queue_s >= thresholdSeconds);

  const runMap = new Map();
  for (const job of longQueued) {
    const runId = extractRunId(job.html_url);
    if (!runId) continue;
    if (!runMap.has(runId)) {
      runMap.set(runId, []);
    }
    runMap.get(runId).push(job);
  }

  return runMap;
}

function printSummary(runMap, thresholdHours) {
  console.log(
    `\nFound ${runMap.size} workflow run(s) with jobs queued longer than ${thresholdHours} hours:\n`
  );
  for (const [runId, jobs] of runMap) {
    const maxQueueS = Math.max(...jobs.map((j) => j.queue_s));
    const hoursQueued = (maxQueueS / 3600).toFixed(1);
    console.log(
      `  Run ${runId} — ${jobs.length} job(s), queued ~${hoursQueued}h`
    );
    for (const job of jobs) {
      const jobHours = (job.queue_s / 3600).toFixed(1);
      console.log(`    - ${job.name || "unnamed"} (${jobHours}h)`);
    }
  }
  console.log();
}

async function cancelRuns(octokit, runMap, dryRun) {
  if (dryRun) {
    console.log("[DRY RUN] No workflow runs were cancelled.\n");
    return;
  }

  let cancelled = 0;
  let failed = 0;

  for (const runId of runMap.keys()) {
    try {
      console.log(`Cancelling run ${runId}...`);
      await octokit.rest.actions.cancelWorkflowRun({
        owner: OWNER,
        repo: REPO,
        run_id: parseInt(runId),
      });
      console.log(`  ✓ Cancelled run ${runId}`);
      cancelled++;
    } catch (err) {
      console.error(`  Failed to cancel run ${runId}: ${err.message}`);
      failed++;
    }
  }

  console.log(
    `\nDone. Cancelled: ${cancelled}, Failed: ${failed}, Total: ${runMap.size}\n`
  );
}

const { thresholdHours, dryRun } = parseArgs();

if (dryRun) {
  console.log("[DRY RUN MODE]");
}
console.log(`Threshold: ${thresholdHours} hours\n`);

const data = await fetchQueuedJobs();
const jobs = Array.isArray(data) ? data : data.jobs || data.data || [];
console.log(`Fetched ${jobs.length} queued job(s) from HUD API.`);

if (jobs.length === 0) {
  console.log("No queued jobs found.");
  process.exit(0);
}

const runMap = filterAndDedup(jobs, thresholdHours);

if (runMap.size === 0) {
  console.log(`No jobs have been queued longer than ${thresholdHours} hours.`);
  process.exit(0);
}

printSummary(runMap, thresholdHours);

const octokit = await getOctokit(OWNER, REPO);
await cancelRuns(octokit, runMap, dryRun);
