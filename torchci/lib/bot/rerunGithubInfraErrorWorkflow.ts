import { Probot } from "probot";

function rerunGithubInfraErrorWorkflow(app: Probot): void {
  // This bot is used to rerun failed workflows on pytorch/pytorch that look
  // like https://github.com/pytorch/pytorch/actions/runs/8454565307
  app.on("workflow_run", async (ctx) => {
    const tagPrefix = "rerunGithubInfraFailure/";
    // Only run this if pytorch/pytorch, failed, is a weird infra error, and is
    // not a previous run of this bot
    ctx.log(
      `Failed workflow_id: ${ctx.payload.workflow_run.id} ` +
        `with conclusion: ${ctx.payload.workflow_run.conclusion} and ` +
        `head_branch: ${ctx.payload.workflow_run.head_branch} and ` +
        `name: ${ctx.payload.workflow_run.name}` +
        `repository: ${ctx.payload.repository.full_name}`
    );
    if (
      ctx.payload.repository.full_name !== "pytorch/pytorch" ||
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
    ctx.log(`Creating new tag: ${tagName}`);
    await ctx.octokit.git.createRef({
      owner: ctx.payload.repository.owner.login,
      repo: ctx.payload.repository.name,
      ref: `refs/tags/${tagName}`,
      sha: ctx.payload.workflow_run.head_sha,
    });
    ctx.log(
      `Triggering workflow for ${ctx.payload.repository.owner.login}/${ctx.payload.repository.name} with ref ${tagName} and workflow_id ${ctx.payload.workflow_run.workflow_id}`
    );
    await ctx.octokit.actions.createWorkflowDispatch({
      owner: ctx.payload.repository.owner.login,
      repo: ctx.payload.repository.name,
      workflow_id: ctx.payload.workflow_run.workflow_id,
      ref: tagName,
    });
  });
}

export default rerunGithubInfraErrorWorkflow;
