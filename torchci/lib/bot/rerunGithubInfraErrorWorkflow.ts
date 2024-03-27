import { Probot } from "probot";

function acceptBot(app: Probot): void {
  // This bot is used to rerun failed workflows on pytorch/pytorch that look
  // like https://github.com/pytorch/pytorch/actions/runs/8454565307
  app.on("workflow_run.completed", async (ctx) => {
    const tagPrefix = "rerunGithubInfraFailure/";
    // Only run this if pytorch/pytorch, failed, is a weird infra error, and is
    // not a previous run of this bot
    if (
      ctx.payload.workflow_run.repository.full_name !== "pytorch/pytorch" ||
      ctx.payload.workflow_run.conclusion !== "failure" ||
      !ctx.payload.workflow_run.name.startsWith(".github/workflows") ||
      ctx.payload.workflow_run.head_branch.startsWith(tagPrefix)
    ) {
      return;
    }
    // Create a new tag instead of using something like ciflow/ since some
    // workflows might have been successfully triggered and we don't want to
    // rerun those
    const tagName = `${tagPrefix}${ctx.payload.workflow_run.id}`;
    await ctx.octokit.git.createRef({
      owner: ctx.payload.repository.owner.login,
      repo: ctx.payload.repository.name,
      ref: tagName,
      sha: ctx.payload.workflow_run.head_sha,
    });
    await ctx.octokit.actions.createWorkflowDispatch({
      owner: ctx.payload.repository.owner.login,
      repo: ctx.payload.repository.name,
      workflow_id: ctx.payload.workflow_run.workflow_id,
      ref: tagName,
    });
  });
}

export default acceptBot;
