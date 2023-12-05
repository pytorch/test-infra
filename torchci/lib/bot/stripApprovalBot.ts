import { Probot } from "probot";
import { hasWritePermissions } from "./utils";

function stripApprovalBot(app: Probot): void {
  app.on("pull_request.reopened", async (ctx) => {
    const pr_author = ctx.payload.pull_request.user.login;

    if (await hasWritePermissions(ctx, pr_author)){
        // if the user has write permissions, we don't need to strip approvals
        return;
    }

    const owner = ctx.payload.repository.owner.login;
    const repo = ctx.payload.repository.name;
    const issue_number = ctx.payload.pull_request.number;

    const reviews = await ctx.octokit.pulls.listReviews({
        owner,
        repo,
        pull_number: issue_number,
      });
    
    const approved_reviews = reviews.data.filter((review) => {
        return review.state === "APPROVED";
    });

    for (const review of approved_reviews) {
        await ctx.octokit.pulls.dismissReview({
            owner,
            repo,
            pull_number: issue_number,
            review_id: review.id,
            message: "This PR was reopened (likely due to being reverted), so your approval was removed. Please request another review.",
        }).catch(error => console.error(error));
    }
    return;
  });
}

export default stripApprovalBot;
