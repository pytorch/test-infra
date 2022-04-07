import { Probot } from "probot";
import { reactOnComment} from './botUtils'

function mergeBot(app: Probot): void {
  const mergeCmdPat = new RegExp("^\\s*@pytorch(merge|)bot\\s+(force\\s+)?merge\\s+this");
  const revertCmdPat = new RegExp("^\\s*@pytorch(merge|)bot\\s+revert\\s+this");
  app.on("issue_comment.created", async (ctx) => {
    const commentBody = ctx.payload.comment.body;
    const owner = ctx.payload.repository.owner.login;
    const repo = ctx.payload.repository.name;
    const prNum = ctx.payload.issue.number;

    async function dispatchEvent(event_type: string, force: boolean = false) {
      let payload = force ? {
        pr_num: prNum,
        comment_id: ctx.payload.comment.id,
        force: true,
      } : {
        pr_num: prNum,
        comment_id: ctx.payload.comment.id,
      };
      await ctx.octokit.repos.createDispatchEvent({
        owner,
        repo,
        event_type: event_type,
        client_payload: payload,
      });
    }

    const match = commentBody.match(mergeCmdPat);
    if (match) {
      if (!ctx.payload.issue.pull_request) {
        // Issue, not pull request.
        await reactOnComment(ctx, "confused");
        return;
      }
      await dispatchEvent("try-merge", typeof match[2] === "string");
      await reactOnComment(ctx, "+1");
    }
    if (commentBody.match(revertCmdPat)) {
      if (!ctx.payload.issue.pull_request) {
        // Issue, not pull request.
        await reactOnComment(ctx, "confused");
        return;
      }
      await dispatchEvent("try-revert");
      await reactOnComment(ctx, "+1");
    }
  });
  app.on(["pull_request_review.submitted", "pull_request_review.edited"], async (ctx) => {
    const reviewBody = ctx.payload.review.body;
    const owner = ctx.payload.repository.owner.login;
    const repo = ctx.payload.repository.name;
    const prNum = ctx.payload.pull_request.number;
    async function addComment(comment: string) {
        await ctx.octokit.issues.createComment({
          issue_number: prNum,
          body: comment,
          owner,
          repo,
        });
    }
    async function dispatchEvent(event_type: string) {
      await ctx.octokit.repos.createDispatchEvent({
        owner,
        repo,
        event_type: event_type,
        client_payload: {
          pr_num: prNum,
        },
      });
    }

    if (reviewBody?.match(mergeCmdPat)) {
      await dispatchEvent("try-merge");
      await addComment("+1"); // REST API doesn't support reactions for code reviews.
    }
  });
}

export default mergeBot;
