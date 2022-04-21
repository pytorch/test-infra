import { Probot, ProbotOctokit } from "probot";
import { reactOnComment, addLabels } from "./botUtils";

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

export default function pingBot(app: Probot): void {
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
      const checks = await ctx.octokit.checks.listForRef({
        ...payloadData,
        ref,
        per_page: 100,
      });

      const [successfulChecks, failedChecks] = categorizeChecks(
        checks.data.check_runs
      );
      // If all jobs are successful or neutral, then try merge, else do nothing
      if (successfulChecks.length === checks.data.check_runs.length) {
        await tryLandPR({
          octokit: ctx.octokit,
          ...payloadData,
          issue_number: prNum,
          comment: "All checks passed. Attempting to merge.",
        });
      }
      // If any failed, alert the author
      else if (failedChecks.length > 0) {
        console.log("INSIDE FAILED");
        await failPR({
          octokit: ctx.octokit,
          ...payloadData,
          issue_number: prNum,
          comment: "Failed to land PR due to red signal.",
        });
      }
    }
  });

  app.on("check_run.completed", async (ctx) => {
    // Check that there are associated PRs that have the label
    const prWithLabelsAwaitable = ctx.payload.check_run.pull_requests.map(
      (pr) => {
        return ctx.octokit.pulls.get({
          ...getPayloadData(ctx),
          pull_number: pr.number,
        });
      }
    );
    const prs = await Promise.all(prWithLabelsAwaitable);
    const landPendingPrs = prs.filter((pr) => {
      const ind = pr.data.labels.find((label) => {
        return label.name === LAND_PENDING;
      });
      return ind != null;
    });

    if (landPendingPrs.length === 0) {
      return;
    }

    if (landPendingPrs.length > 1) {
      // If there's more than 1 land pending PR with the same checks,
      // then we don't know which one to land
      return;
    }

    const landPendingPr = prs[0];
    // Check the other land signals
    const checks = await ctx.octokit.checks.listForRef({
      ...getPayloadData(ctx),
      ref: landPendingPr.data.head.ref,
      per_page: 100,
    });

    const [successfulChecks, failedChecks] = categorizeChecks(
      checks.data.check_runs
    );

    const conclusion = ctx.payload["check_run"].conclusion;

    const prData = {
      octokit: ctx.octokit,
      ...getPayloadData(ctx),
      issue_number: landPendingPr.data.number,
    };
    console.log(
      "CONCLUSION IS",
      conclusion,
      conclusion != "success" && conclusion != "neutral"
    );
    if (conclusion !== "success" && conclusion !== "neutral") {
      // Only alert if this is the first failure
      if (failedChecks.length < 1) {
        await failPR({
          ...prData,
          comment: "Failed to land PR due to failing signal",
        });
      }
    } else if (successfulChecks.length === checks.data.check_runs.length) {
      console.log("GOING IN HERE");
      await tryLandPR({
        ...prData,
        comment: "All checks passed. Attempting to merge.",
      });
    }
  });
}

function categorizeChecks(check_runs: any[]) {
  const successfulChecks = check_runs.filter(
    (check) => check.conclusion === "success" || check.conclusion === "neutral"
  );
  const failedChecks = check_runs.filter(
    (check) =>
      check.conclusion !== "success" &&
      check.conclusion !== "neutral" &&
      check.conclusion != null
  );
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
