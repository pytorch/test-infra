import { Probot } from "probot";

function labelBot(app: Probot): void {
  // labels start with non space char \\w and follow by list of labels separated by comma
  const labelCommand = new RegExp("@pytorchbot\\s+label\\s+(\\w[\\w\\s.:,]+)");

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

    async function addLabels(labelsToAdd: string[]) {
      await ctx.octokit.issues.addLabels({
        owner: owner,
        repo: repo,
        issue_number: prNum,
        labels: labelsToAdd,
      });
    }

    if (commentBody.match(labelCommand)) {
      if (!ctx.payload.issue.pull_request) {
        // Issue, not pull request.
        await reactOnComment("confused");
        return;
      }
      const regexExecLabels = labelCommand.exec(commentBody);
      if (regexExecLabels != null) {
        // remove unnecessary spaces from labels
        const labelsToAdd = regexExecLabels[1].split(",").map((s) => s.trim());
        await addLabels(labelsToAdd);
        await reactOnComment("+1");
      }
    }
  });
}

export default labelBot;
