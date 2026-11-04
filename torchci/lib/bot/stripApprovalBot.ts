import { Context, Probot, ProbotOctokit } from "probot";
import { hasWritePermissions, isPyTorchbotSupportedOrg } from "./utils";

const REOPENED_MESSAGE =
  "This PR was reopened (likely due to being reverted), so your approval was removed. Please request another review.";

const SYNCHRONIZE_MESSAGE =
  "New commits were pushed to this PR after it was approved, so your approval was removed. Please review the new commits and approve again.";

interface PullRequestRef {
  owner: string;
  repo: string;
  pull_number: number;
}

// Takes the octokit and the PR coordinates rather than the Context, because the union
// of the two event contexts is too large for tsc to represent.
async function dismissApprovals(
  octokit: InstanceType<typeof ProbotOctokit>,
  { owner, repo, pull_number }: PullRequestRef,
  message: string
): Promise<void> {
  // Paginated because GitHub returns reviews oldest first: on a PR with more than
  // one page of reviews, the unpaginated call returns the oldest page and leaves
  // the recent approvals -- the ones that authorize a merge -- in place.
  const reviews = await octokit.paginate(octokit.pulls.listReviews, {
    owner,
    repo,
    pull_number,
    per_page: 100,
  });

  for (const review of reviews.filter(
    (review) => review.state === "APPROVED"
  )) {
    await octokit.pulls
      .dismissReview({
        owner,
        repo,
        pull_number,
        review_id: review.id,
        message,
      })
      .catch((error) => console.error(error));
  }
}

function pullRequestRef(payload: {
  repository: { owner: { login: string }; name: string };
  pull_request: { number: number };
}): PullRequestRef {
  return {
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    pull_number: payload.pull_request.number,
  };
}

export default function stripApprovalBot(app: Probot): void {
  app.on(
    ["pull_request.reopened"],
    async (ctx: Context<"pull_request.reopened">) => {
      const owner = ctx.payload.repository.owner.login;
      if (!isPyTorchbotSupportedOrg(owner)) {
        ctx.log(`${__filename} isn't enabled on ${owner}'s repos`);
        return;
      }

      // Keyed on the author: reopening is how a reverted PR gets its old approval
      // back, and the author is who benefits from that.
      if (await hasWritePermissions(ctx, ctx.payload.pull_request.user.login)) {
        return;
      }

      await dismissApprovals(
        ctx.octokit,
        pullRequestRef(ctx.payload),
        REOPENED_MESSAGE
      );
    }
  );

  app.on(
    ["pull_request.synchronize"],
    async (ctx: Context<"pull_request.synchronize">) => {
      const owner = ctx.payload.repository.owner.login;
      if (!isPyTorchbotSupportedOrg(owner)) {
        ctx.log(`${__filename} isn't enabled on ${owner}'s repos`);
        return;
      }

      // Keyed on the pusher rather than the PR author, for two reasons: `@pytorchbot
      // merge -r` rebases as pytorchmergebot and must not strip the approval it is
      // about to act on, and a maintainer pushing a fix to a fork branch has not
      // invalidated their own review.
      if (await hasWritePermissions(ctx, ctx.payload.sender.login)) {
        return;
      }

      await dismissApprovals(
        ctx.octokit,
        pullRequestRef(ctx.payload),
        SYNCHRONIZE_MESSAGE
      );
    }
  );
}
