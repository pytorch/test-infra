import { Probot } from "probot";
// Removes bot comment created by check_labels.py in pytorch/pytorch

function removeLabelComment(app: Probot): void {
  app.on("pull_request.labeled", async (ctx) => {
    const label = ctx.payload.label.name;
    if (
      label.startsWith("release notes:") ||
      label === "topic: not user facing"
    ) {
      const owner = ctx.payload.repository.owner.login;
      const repo = ctx.payload.repository.name;
      const pull_number = ctx.payload.pull_request.comments;

      let comments = [];
      let data = [];
      let i = 1;
      do {
        data = (
          await ctx.octokit.rest.issues.listComments({
            owner,
            repo,
            issue_number: pull_number,
            per_page: 100,
            page: i,
          })
        ).data;
        comments.push(...data);
        i += 1;
      } while (data.length != 0);

      comments.forEach(async (comment) => {
        if (
          comment.user?.login === "github-actions[bot]" &&
          comment.body?.startsWith("# This PR needs a label")
        ) {
          await ctx.octokit.issues.deleteComment({
            owner,
            repo,
            comment_id: comment.id,
          });
        }
      });
    }
  });
}
export default removeLabelComment;
