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
    async function reactOnComment(reaction: "+1" | "confused") {
      await ctx.octokit.reactions.createForIssueComment({
        comment_id: commentId,
        content: reaction,
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

    if (commentBody.match(mergeCmdPat)) {
      if (!ctx.payload.issue.pull_request) {
        // Issue, not pull request.
        await reactOnComment("confused");
        return;
      }
      await dispatchEvent("try-merge");
      await reactOnComment("+1");
    }
    if (commentBody.match(revertCmdPat)) {
      if (!ctx.payload.issue.pull_request) {
        // Issue, not pull request.
        await reactOnComment("confused");
        return;
      }
      await dispatchEvent("try-revert");
      await reactOnComment("+1");
    }
  });
}

export default mergeBot;
