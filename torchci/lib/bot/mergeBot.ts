import { Probot } from "probot";

function mergeBot(app: Probot): void {
  const mergeCmdPat = new RegExp("@pytorch(merge|)bot\\s+merge\\s+this");
  const revertCmdPat = new RegExp("@pytorch(merge|)bot\\s+revert\\s+this");
  app.on("issue_comment.created", async (ctx) => {
    const commentBody = ctx.payload.comment.body;
    const owner = ctx.payload.repository.owner.login;
    const repo = ctx.payload.repository.name;
    const commentId = ctx.payload.comment.id;
    const prNum = ctx.payload.issue.number;
    if (commentBody.match(mergeCmdPat)) {
      if (!ctx.payload.issue.pull_request) {
        // Issue, not pull request.
        await ctx.octokit.reactions.createForIssueComment({
          comment_id: commentId,
          content: "confused",
          owner,
          repo,
        });
        return;
      }
      await ctx.octokit.repos.createDispatchEvent({
        owner,
        repo,
        event_type: "try-merge",
        client_payload: {
          pr_num: prNum,
        },
      });
      await ctx.octokit.reactions.createForIssueComment({
        comment_id: commentId,
        content: "+1",
        owner,
        repo,
      });
    }
    if (commentBody.match(revertCmdPat)) {
      if (!ctx.payload.issue.pull_request) {
        // Issue, not pull request.
        await ctx.octokit.reactions.createForIssueComment({
          comment_id: commentId,
          content: "confused",
          owner,
          repo,
        });
        return;
      }
      await ctx.octokit.repos.createDispatchEvent({
        owner,
        repo,
        event_type: "try-revert",
        client_payload: {
          pr_num: prNum,
        },
      });
      await ctx.octokit.reactions.createForIssueComment({
        comment_id: commentId,
        content: "+1",
        owner,
        repo,
      });
    }
  });
}

export default mergeBot;
