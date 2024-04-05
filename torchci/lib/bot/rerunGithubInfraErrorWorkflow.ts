import { Probot } from "probot";

const tagPrefix = "rerunGithubInfraFailure/";

function rerunGithubInfraErrorWorkflow(app: Probot): void {
  let reruns: Map<string, number> = new Map();
  let day = 0;

  // This bot is used to rerun failed workflows on pytorch/pytorch that look
  // like https://github.com/pytorch/pytorch/actions/runs/8454565307
  app.on("workflow_run.requested", async (ctx) => {
    if (day != new Date().getDate()) {
      // Reset reruns every day
      day = new Date().getDate();
      reruns = new Map();
    }
    // Only run this if pytorch/pytorch, failed, is a weird infra error, and is
    // not a previous run of this bot
    ctx.log(
      `Workflow_id: ${ctx.payload.workflow_run.id} ` +
        `with conclusion: ${ctx.payload.workflow_run.conclusion} and ` +
        `head_branch: ${ctx.payload.workflow_run.head_branch} and ` +
        `name: ${ctx.payload.workflow_run.name} and ` +
        `repository: ${ctx.payload.repository.full_name} `
    );
    if (
      ctx.payload.repository.full_name !== "pytorch/pytorch" ||
      ctx.payload.workflow_run.conclusion !== "failure" ||
      !ctx.payload.workflow_run.name.startsWith(".github/workflows") ||
      ctx.payload.workflow_run.head_branch.startsWith(tagPrefix)
    ) {
      return;
    }
    if (
      reruns.has(ctx.payload.workflow_run.head_sha) &&
      reruns.get(ctx.payload.workflow_run.head_sha)! > 10
    ) {
      ctx.log(
        `Not rerunning ${ctx.payload.workflow_run.id} as sha ${ctx.payload.workflow_run.head_sha} has been rerun too many times`
      );
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
    reruns.set(
      ctx.payload.workflow_run.head_sha,
      (reruns.get(ctx.payload.workflow_run.head_sha) || 0) + 1
    );
  });

  app.on("workflow_run.completed", async (ctx) => {
    // Delete tag on workflow completion
    if (
      ctx.payload.repository.full_name == "pytorch/pytorch" &&
      ctx.payload.workflow_run.head_branch.startsWith(tagPrefix)
    ) {
      await ctx.octokit.git.deleteRef({
        owner: ctx.payload.repository.owner.login,
        repo: ctx.payload.repository.name,
        ref: `tags/${ctx.payload.workflow_run.head_branch}`,
      });
    }
  });

  app.on("workflow_run.requested", async (ctx) => {
    // Delete tag on failure to rerun
    if (
      ctx.payload.repository.full_name == "pytorch/pytorch" &&
      ctx.payload.workflow_run.conclusion == "failure" &&
      ctx.payload.workflow_run.name.startsWith(".github/workflows") &&
      ctx.payload.workflow_run.head_branch.startsWith(tagPrefix)
    ) {
      await ctx.octokit.git.deleteRef({
        owner: ctx.payload.repository.owner.login,
        repo: ctx.payload.repository.name,
        ref: `tags/${ctx.payload.workflow_run.head_branch}`,
      });
    }
  });
}

export default rerunGithubInfraErrorWorkflow;
