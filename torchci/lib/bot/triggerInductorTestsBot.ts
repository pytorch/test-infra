import { Context, Probot } from "probot";
import { reactOnComment } from "./utils";

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
      if (
        commentBody.includes("@pytorch run pytorch tests") &&
        preapprovedUsers.includes(commenter) &&
        preapprovedRepos.includes(orgRepo)
      ) {
        const workflow_owner = "pytorch";
        const workflow_repo = "pytorch-integration-testing";
        const workflow_id = "inductor.yml";
        const pytorchCommit = "viable/strict";

        let tritonCommit = "main";

        reactOnComment(ctx, "+1");

        // if on the triton repo, get the commit of the pr
        if (orgRepo === tritonRepo) {
          const pr = await ctx.octokit.pulls.get({
            owner: ctx.payload.repository.owner.login,
            repo: ctx.payload.repository.name,
            pull_number: ctx.payload.issue.number,
          });
          tritonCommit = pr.data.head.sha;
        }

        try {
          await ctx.octokit.actions.createWorkflowDispatch({
            owner: workflow_owner,
            repo: workflow_repo,
            workflow_id,
            ref: "main",
            inputs: {
              triton_commit: tritonCommit,
              pytorch_commit: pytorchCommit,
            },
          });

          await ctx.octokit.issues.createComment({
            owner: ctx.payload.repository.owner.login,
            repo: ctx.payload.repository.name,
            issue_number: ctx.payload.issue.number,
            body: `Inductor tests triggered successfully with pytorch commit: ${pytorchCommit} and triton commit: ${tritonCommit}`,
          });
        } catch (error) {
          console.error("Error triggering workflow:", error);
          await ctx.octokit.issues.createComment({
            owner: ctx.payload.repository.owner.login,
            repo: ctx.payload.repository.name,
            issue_number: ctx.payload.issue.number,
            body: `Failed to trigger Inductor tests. Please check the logs. Failed with error ${error}`,
          });
        }
      }
    }
  );
}
