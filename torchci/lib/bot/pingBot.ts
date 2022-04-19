import { Context, Probot } from "probot";
import {
  reactOnComment,
  addLabels,
  addComment,
  removeLabels,
} from "./botUtils";

const openOnGreen = new RegExp("^s*@pytorchbots+?mergeOnGreen.*");
const LAND_PENDING = "land-pending";
const LAND_ATTEMPT = "landed-attempt";
const LAND_FAILED = "land-failed";

export default function pingBot(app: Probot): void {
  app.on("issue_comment.created", async (ctx) => {
    const commentBody = ctx.payload.comment.body;
    if (commentBody.match(openOnGreen)) {
      if (!ctx.payload.issue.pull_request) {
        // Issue, not pull request.
        await reactOnComment(ctx, "confused");
        return;
      } else {
        await reactOnComment(ctx, "+1");
        await addLabels(ctx, [LAND_PENDING]);
      }
    }
  });

  app.on(["pull_request.labeled"], async (ctx) => {
    const labelNames = ctx.payload["pull_request"].labels.map(
      (label) => label.name
    );

    if (labelNames.includes(LAND_PENDING)) {
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

      const nonSuccessfulChecks = checks?.data.check_runs.filter(
        (check) =>
          check.conclusion !== "success" && check.conclusion !== "neutral"
      );
      // If all jobs are successful or neutral, then try merge, else do nothing
      if (nonSuccessfulChecks.length === 0) {
        tryLandPR(ctx, prNum);
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
      return (
        pr.data.labels.find((label) => {
          return label.name === LAND_PENDING;
        }) != undefined
      );
    });

    if (landPendingPrs.length === 0) {
      return;
    }

    if (landPendingPrs.length > 1) {
      await failPR(
        ctx,
        "There are multiple land pending PRs that rely on this check run. Aborting due to potential land race."
      );
      return;
    }

    const landPendingPr = prs[0];
    // Check the other land signals
    const checks = await ctx.octokit.checks.listForRef({
      ...getPayloadData(ctx),
      ref: landPendingPr.data.head.ref,
      per_page: 100,
    });

    const successfulChecks = checks.data.check_runs.filter(
      (check) => check.conclusion == "success" || check.conclusion == "neutral"
    );

    const conclusion = ctx.payload["check_run"].conclusion;

    if (conclusion != "success" && conclusion != "neutral") {
      await failPR(
        ctx,
        "Failed to land due to red signal: " + ctx.payload["check_run"].name
      );
    } else {
      if (successfulChecks.length === checks.data.check_runs.length) {
        await tryLandPR(ctx, landPendingPr.data.number);
      }
    }
  });
}

async function failPR(ctx: any, comment: string) {
  await addComment(ctx, comment);
  await addLabels(ctx, [LAND_FAILED]);
  await removeLabels(ctx, [LAND_PENDING]);
}

async function tryLandPR(ctx: any, prNum: number) {
  await addComment(ctx, "All jobs finished successfully. Attempting to land.");
  await removeLabels(ctx, [LAND_PENDING]);
  await addLabels(ctx, [LAND_ATTEMPT]);
  await ctx.octokit.repos.createDispatchEvent({
    ...getPayloadData(ctx),
    event_type: "try_merge",
    client_payload: {
      pr_num: prNum,
    },
  });
}

function getPayloadData(ctx: any) {
  return {
    owner: ctx.payload.repository.owner.login,
    repo: ctx.payload.repository.name,
  };
}
