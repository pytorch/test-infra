import { Probot } from "probot";

function isTheBotStateful(app: Probot): void {
  let time = 0;

  // This bot is used to rerun failed workflows on pytorch/pytorch that look
  // like https://github.com/pytorch/pytorch/actions/runs/8454565307
  app.on("issue_comment.created", async (ctx) => {
    if (
      ctx.payload.repository.full_name == "malfet/deleteme" &&
      ctx.payload.issue.number == 83 &&
      ctx.payload.comment.user.login == "clee2000"
    ) {
      await ctx.octokit.issues.createComment({
        owner: ctx.payload.repository.owner.login,
        repo: ctx.payload.repository.name,
        issue_number: ctx.payload.issue.number,
        body: `hello! ${time}`,
      });
      time += 1;
    }
  });
}

export default isTheBotStateful;
