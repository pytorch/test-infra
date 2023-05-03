import { Label } from "@octokit/webhooks-types";
import { Probot } from "probot";
import { addLabels } from "./utils";

function containsLabel(labels: Label[], labelName: string) {
  return labels.filter((label) => label.name === labelName).length > 0;
}

export const CIFLOW_TRUNK_LABEL = "ciflow/trunk";

function acceptBot(app: Probot): void {
  app.on("pull_request.labeled", async (ctx) => {
    const owner = ctx.payload.repository.owner.login;
    const repo = ctx.payload.repository.name;
    const issue_number = ctx.payload.pull_request.number;
    ctx.payload.pull_request;

    async function isApproved(): Promise<boolean> {
      const reviews = await ctx.octokit.pulls.listReviews({
        owner,
        repo,
        pull_number: issue_number,
      });
      const isApproved =
        reviews.data.filter((review) => review.state == "approved").length > 0;
      return isApproved;
    }
  });
}

export default acceptBot;
