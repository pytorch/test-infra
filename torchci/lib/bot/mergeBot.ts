import { Probot } from "probot";

function mergeBot(app: Probot): void {
  const cmdPat = new RegExp("@pytorchbot\\s+merge\\s+this");
  app.on("issue_comment.created", async (ctx) => {
    const commentBody = ctx.payload.comment.body;
    const owner = ctx.payload.repository.owner.login;
    const repo = ctx.payload.repository.name;
    const commentId = ctx.payload.comment.id;
    const prNum = ctx.payload.issue.number;
    if (commentBody.match(cmdPat)) {
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
  });
}

export default mergeBot;
