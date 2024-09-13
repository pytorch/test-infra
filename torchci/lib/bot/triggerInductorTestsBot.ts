import { Context, Probot } from "probot";

export default function triggerInductorTestsBot(app: Probot): void {
  const preapprovedUsers = ["pytorchbot", "PaliC"]; // List of preapproved users
  const preapprovedRepos = ["malfet/deleteme"]; // List of preapproved orgs/repos

  app.on(
    ["issue_comment.created"],
    async (ctx: Context<"issue_comment.created">) => {
      const commentBody = ctx.payload.comment.body.toLowerCase();
      const commenter = ctx.payload.comment.user.login;
      const orgRepo = `${ctx.payload.repository.owner.login}/${ctx.payload.repository.name}`;

      if (
        commentBody.includes("trigger inductor tests") &&
        preapprovedUsers.includes(commenter) &&
        preapprovedRepos.includes(orgRepo)
      ) {
        const owner = ctx.payload.repository.owner.login;
        const repo = ctx.payload.repository.name;
        const issue_number = ctx.payload.issue.number;

        await ctx.octokit.issues.createComment({
          owner,
          repo,
          issue_number,
          body: "Inductor tests triggered",
        });
      }
    }
  );
}
