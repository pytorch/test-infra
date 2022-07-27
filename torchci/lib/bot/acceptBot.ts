import { Label } from "@octokit/webhooks-types";
import { Probot } from "probot";

function containsLabel(labels: Label[], labelName: string) {
  return labels.filter((label) => label.name === labelName).length > 0;
}

export const ACCEPT_2_RUN = "accept2run";
export const ACCEPT_2_SHIP = "accept2ship";
export const CIFLOW_ALL = "ciflow/all";

export const ACCEPT_MESSAGE_PREFIX =
  "This PR has been accepted with the accept2ship label. Attempting to merge now.";

export const ACCEPT_MESSAGE = `${ACCEPT_MESSAGE_PREFIX}

@pytorchbot merge -l
`;

function acceptBot(app: Probot): void {
  app.on(["pull_request_review.submitted"], async (ctx) => {
    if (ctx.payload.repository.name != "pytorch-canary") {
      return;
    }
    if (ctx.payload.review.state === "approved") {
      const labels = ctx.payload.pull_request.labels;
      const owner = ctx.payload.repository.owner.login;
      const repo = ctx.payload.repository.name;
      const issue_number = ctx.payload.pull_request.number;

      const hasAcceptToRun = containsLabel(labels, ACCEPT_2_RUN);
      const hasAcceptToShip = containsLabel(labels, ACCEPT_2_SHIP);

      if (hasAcceptToRun) {
        await ctx.octokit.issues.addLabels({
          owner,
          repo,
          issue_number,
          labels: [CIFLOW_ALL],
        });
      } else if (hasAcceptToShip) {
        await ctx.octokit.issues.createComment({
          owner,
          repo,
          issue_number,
          body: ACCEPT_MESSAGE,
        });
      }
    }
  });
}

export default acceptBot;
