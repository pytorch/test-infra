import { Context, Probot } from "probot";

export default function triggerInductorTestsBot(app: Probot): void {
  const preapprovedUsers = ["pytorchbot", "PaliC"]; // List of preapproved users
  //   const tritonRepo = "triton-lang/triton"; // uncomment once this is good enough for triton
  const tritonRepo = "triton-lang-test/triton"; // delete once this is good enough for triton
  const preapprovedRepos = ["malfet/deleteme", tritonRepo]; // List of preapproved orgs/repos
  //   const preapprovedRepos = ["malfet/deleteme", "triton-lang/triton"];// uncomment once this is good enough for triton and delete line above

  app.on(
    ["issue_comment.created"],
    async (ctx: Context<"issue_comment.created">) => {
      const commentBody = ctx.payload.comment.body.toLowerCase();
      const commenter = ctx.payload.comment.user.login;
      const orgRepo = `${ctx.payload.repository.owner.login}/${ctx.payload.repository.name}`;
      const tritonCommit = "main";
      if (orgRepo === tritonRepo) {
        // get commit of pr
      }
      if (
        commentBody.includes("trigger inductor tests") &&
        preapprovedUsers.includes(commenter) &&
        preapprovedRepos.includes(orgRepo)
      ) {
        const workflow_owner = "pytorch";
        const workflow_repo = "pytorch-integration-testing";
        const workflow_id = "triton-inductor.yml";

        try {
          await ctx.octokit.actions.createWorkflowDispatch({
            owner: workflow_owner,
            repo: workflow_repo,
            workflow_id,
            ref: "main",
            inputs: {
              triton_commit: "main",
              pytorch_commit: "viable/strict",
            },
          });

          await ctx.octokit.issues.createComment({
            owner: ctx.payload.repository.owner.login,
            repo: ctx.payload.repository.name,
            issue_number: ctx.payload.issue.number,
            body: "Inductor tests triggered successfully",
          });
        } catch (error) {
          console.error("Error triggering workflow:", error);
          await ctx.octokit.issues.createComment({
            owner: ctx.payload.repository.owner.login,
            repo: ctx.payload.repository.name,
            issue_number: ctx.payload.issue.number,
            body: "Failed to trigger Inductor tests. Please check the logs.",
          });
        }
      }
    }
  );
}
