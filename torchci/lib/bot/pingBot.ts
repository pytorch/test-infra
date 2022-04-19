import { Context, Probot } from "probot";
import { reactOnComment, addLabels } from "./botUtils";

export default function pingBot(app: Probot): void {
  const openOnGreen = new RegExp("^s*@pytorchbots+?mergeOnGreen.*");
  const LAND_PENDING = "land-pending";
  const LANDED = "landed";
  const LAND_FAILED = "land-failed";

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
      const payloadData = getPayloadDataForMerge(ctx);
      const ref = ctx.payload.pull_request.head.sha;
      const prNum = ctx.payload.pull_request.number;
      const checks = await ctx.octokit.checks.listForRef({
        ...payloadData,
        ref,
        per_page: 100,
      });

      const notSuccessfulJobs = checks?.data.check_runs.filter(
        (check) =>
          check.conclusion !== "success" && check.conclusion !== "neutral"
      );
      // If there's any jobs that aren't successful yet
      if (notSuccessfulJobs.length === 0) {
        await ctx.octokit.repos.createDispatchEvent({
          ...payloadData,
          event_type: "try_merge",
          client_payload: {
            pr_num: prNum,
          },
        });
      }
    }
  });

  app.on("check_run.completed", async (ctx) => {
    const conclusion = ctx.payload["check_run"].conclusion;
    if (conclusion === "success") {
      // Check pull requests and see if it has all green and merge
    } else if (conclusion === "failure") {
      // @ the author that it's failed to land and add land-failed
    }
  });
}

function getPayloadDataForMerge(ctx: any) {
  return {
    owner: ctx.payload.repository.owner.login,
    repo: ctx.payload.repository.name,
  };
}
