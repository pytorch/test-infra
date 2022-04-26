import { Probot, ProbotOctokit } from "probot";
import { reactOnComment, addLabels } from "./botUtils";
import getRocksetClient from "lib/rockset";
import rocksetVersions from "rockset/prodVersions.json";

const openOnGreen = new RegExp("^s*@pytorchbot\\s+?mergeOnGreen.*");
export const LAND_PENDING = "land-pending";
const LAND_ATTEMPT = "landed-attempt";
const LAND_FAILED = "land-failed";

type OctokitData = {
  octokit: InstanceType<typeof ProbotOctokit>;
  owner: string;
  repo: string;
  issue_number: number;
  comment: string;
};

export default function greenBot(app: Probot): void {
  app.on("issue_comment.created", async (ctx) => {
    const commentBody = ctx.payload.comment.body;
    if (commentBody.match(openOnGreen)) {
      if (!ctx.payload.issue.pull_request) {
        // Issue, not pull request.
        await reactOnComment(ctx, "confused");
      } else {
        await reactOnComment(ctx, "+1");
        await addLabels(ctx, [LAND_PENDING]);
      }
    }
  });

  app.on(["pull_request.labeled"], async (ctx) => {
    if (ctx.payload.label.name === LAND_PENDING) {
      // Check pull request's head ref and check runs to see if it has all green and merge if it's good
      // TODO: Add pagination if checks go above 100
      const payloadData = getPayloadData(ctx);
      const ref = ctx.payload.pull_request.head.sha;
      const prNum = ctx.payload.pull_request.number;
      const jobs = await getJobsBySha(ref);
      const [successfulJobs, failedJobs] = categorizeJobs(jobs);
      // If all jobs are successful or neutral, then try merge, else do nothing
      if (successfulJobs.length === jobs.length) {
        await tryLandPR({
          octokit: ctx.octokit,
          ...payloadData,
          issue_number: prNum,
          comment: "All checks passed. Attempting to merge.",
        });
      }
      // If any failed, alert the author
      else if (failedJobs.length > 0) {
        await failPR({
          octokit: ctx.octokit,
          ...payloadData,
          issue_number: prNum,
          comment: "Failed to land PR due to red signal.",
        });
      }
    }
  });

  app.on("workflow_job.completed", async (ctx) => {
    const rocksetClient = getRocksetClient();
    // Get all PRs that have this as the head SHA and the land pending label
    const landPendingPrQuery =
      await rocksetClient.queryLambdas.executeQueryLambda(
        "commons",
        "prs_with_label",
        rocksetVersions.commons.prs_with_label,
        {
          parameters: [
            {
              name: "label",
              type: "string",
              value: LAND_PENDING,
            },
            {
              name: "sha",
              type: "string",
              value: ctx.payload.workflow_job.head_sha,
            },
          ],
        }
      );

    const prs = landPendingPrQuery?.results;
    if (prs == null || prs?.length === 0) {
      return;
    }

    if (prs.length > 1) {
      // If there's more than 1 PR with the same head sha and the land-pending label,
      // Then we don't want to potentially race.
      return;
    }

    const landPendingPr = prs[0];

    const jobs = await getJobsBySha(landPendingPr.sha);
    const [successfulChecks, failedChecks] = categorizeJobs(jobs);

    const conclusion = ctx.payload.workflow_job.conclusion;

    const prData = {
      octokit: ctx.octokit,
      ...getPayloadData(ctx),
      issue_number: landPendingPr.number,
    };
    if (conclusion == "failure") {
      // Only alert if this is the first failure
      if (failedChecks.length <= 1) {
        await failPR({
          ...prData,
          comment: "Failed to land PR due to failing signal",
        });
      }
    } else if (successfulChecks.length === jobs.length) {
      await tryLandPR({
        ...prData,
        comment: "All checks passed. Attempting to merge.",
      });
    }
  });
}

async function getJobsBySha(sha: string) {
  const rocksetClient = getRocksetClient();

  const jobsQuery = await rocksetClient.queryLambdas.executeQueryLambda(
    "commons",
    "workflow_jobs_for_sha",
    rocksetVersions.commons.workflow_jobs_for_sha,
    {
      parameters: [
        {
          name: "sha",
          type: "string",
          value: sha,
        },
      ],
    }
  );
  return jobsQuery.results ?? [];
}

function categorizeJobs(jobs: any[]) {
  const successfulChecks = [];
  const failedChecks = [];
  for (const job of jobs) {
    if (
      job.conclusion === "success" ||
      job.conclusion === "neutral" ||
      job.conclusion === "skipped"
    ) {
      successfulChecks.push(job);
    } else {
      failedChecks.push(job);
    }
  }
  return [successfulChecks, failedChecks];
}

async function failPR({
  octokit,
  owner,
  repo,
  issue_number,
  comment,
}: OctokitData) {
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number,
    body: comment,
  });
  await octokit.issues.addLabels({
    owner,
    repo,
    issue_number,
    labels: [LAND_FAILED],
  });
  await octokit.issues.removeLabel({
    owner: owner,
    repo: repo,
    issue_number,
    name: LAND_PENDING,
  });
}

async function tryLandPR({
  octokit,
  owner,
  repo,
  issue_number,
  comment,
}: OctokitData) {
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number,
    body: comment,
  });
  await octokit.issues.addLabels({
    owner: owner,
    repo: repo,
    issue_number,
    labels: [LAND_ATTEMPT],
  });
  await octokit.issues.removeLabel({
    owner: owner,
    repo: repo,
    issue_number,
    name: LAND_PENDING,
  });
  await octokit.repos.createDispatchEvent({
    owner,
    repo,
    event_type: "try_merge",
    client_payload: {
      pr_num: issue_number,
    },
  });
}

function getPayloadData(ctx: any) {
  return {
    owner: ctx.payload.repository.owner.login,
    repo: ctx.payload.repository.name,
  };
}
