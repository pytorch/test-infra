import { PullRequest } from "lib/types";
import { Context, Probot } from "probot";
import { hasWritePermissions } from "./utils";

export default function stripApprovalBot(app: Probot): void {
  app.on(
    ["pull_request.reopened"],
    async (ctx: Context<"pull_request.reopened">) => {
      const pullRequest: PullRequest = ctx.payload.pull_request;
      const pr_author = pullRequest.user.login;
      console.log("pr_author: ", pr_author);
      // cause error
      if (await hasWritePermissions(ctx, pr_author)) {
        // if the user has write permissions, we don't need to strip approvals
        return;
      }

      const pull_request: PullRequest = ctx.payload.pull_request

      const owner = ctx.payload.repository.owner.login;
      const repo = ctx.payload.repository.name;
      const issue_number = pull_request.number;

      const reviews = await ctx.octokit.pulls.listReviews({
        owner,
        repo,
        pull_number: issue_number,
      });

      const approved_reviews = reviews.data.filter((review) => {
        return review.state === "APPROVED";
      });

      for (const review of approved_reviews) {
        await ctx.octokit.pulls
          .dismissReview({
            owner,
            repo,
            pull_number: issue_number,
            review_id: review.id,
            message:
              "This PR was reopened (likely due to being reverted), so your approval was removed. Please request another review.",
          })
          .catch((error) => console.error(error));
      }
      return;
    }
  );
}
