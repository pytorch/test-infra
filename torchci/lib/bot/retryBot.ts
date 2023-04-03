import { Probot } from "probot";
import { CachedConfigTracker } from "./utils";

const FAILURE_CONCLUSIONS = ["failure", "cancelled", "timed_out"];

function retryBot(app: Probot): void {
  const tracker = new CachedConfigTracker(app);

  app.on("workflow_run.completed", async (ctx, tracker) => {
    const workflowName = ctx.payload.workflow_run.name;
    const attemptNumber = ctx.payload.workflow_run.run_attempt;
    const defaultBranch = ctx.payload.repository.default_branch;
    const owner = ctx.payload.repository.owner.login;
    const repo = ctx.payload.repository.name;
    const runId = ctx.payload.workflow_run.id;

    const config: any = await tracker.loadConfig(ctx);
    if (config === null) {
        return;
    }
    const allowedWorkflowPrefixes: string[] = config["allowed_workflows"];

//     const allowedWorkflowPrefixes: { [key: string]: string[] } = {
//         "pytorch": ["lint", "pull", "trunk", "linux-binary", "windows-binary"],
//         "vision": ["lint", "Build Linux", "Build Macos", "Build M1", "Tests on Linux", "Tests on macOS"]
//     }
//     const allowedRepoPrefixes = allowedWorkflowPrefixes[repo] ? allowedWorkflowPrefixes[repo] : allowedWorkflowPrefixes["pytorch"];

    if (
      ctx.payload.workflow_run.conclusion === "success" ||
      (
        ctx.payload.workflow_run.conclusion === "cancelled" &&
        ctx.payload.workflow_run.head_branch !== defaultBranch
      ) ||
      attemptNumber > 1 ||
      allowedRepoPrefixes.every(
        allowedWorkflow => !workflowName.toLowerCase().includes(allowedWorkflow.toLowerCase())
      )
    ) {
      return;
    }

    let workflowJobs = [];
    let total_count = 1;
    const jobs_per_page = 100;
    for (let i = 0; i * jobs_per_page < total_count; i++) {
      const data = (
        await ctx.octokit.rest.actions.listJobsForWorkflowRunAttempt({
          owner,
          repo,
          run_id: runId,
          attempt_number: attemptNumber,
          page: i + 1,
          per_page: jobs_per_page,
        })
      ).data;
      total_count = data.total_count;
      workflowJobs.push(...data.jobs);
    }

    const failedJobs = workflowJobs.filter((job) =>
      FAILURE_CONCLUSIONS.includes(job.conclusion!)
    );
    if (failedJobs.length > 5) {
      // if you have more than 5 failing jobs, its probably either a real failure, a landrace,
      // or a widespread outage that wouldn't be helped by retries
      return;
    }

    // @ts-expect-error - we don't have types for these
    let doesLookLikeUserFailure = (job, isCodeValiationStep: (step: any) => boolean) => {
      // Ensure if any of the steps that failed are not infra related steps (e.g. they're lint, build or test steps)
      return job.steps?.filter(
        // @ts-expect-error
        (step) =>
          step.conclusion !== null &&
          FAILURE_CONCLUSIONS.includes(step.conclusion) &&
          isCodeValiationStep(step) 
      ).length > 0
    }

    const shouldRetry = failedJobs.filter((job) => {
      // If the job was cancelled on master, it was probably an infra error, so rerun.
      // On other branches, it could have been cancelled for valid reasons, so we won't rerun.
      // Would be good to fine tune this further for non-master branches to differentiate between.
      // retryable and nonretryable cancellations
      if (job.conclusion === "cancelled" &&
          ctx.payload.workflow_run.head_branch === "master") {
        return true;
      }

      // don't rerun if the linter failed on the actual linting steps, which have the nonretryable suffix
      if (workflowName.toLocaleLowerCase() === "lint") {
          return !doesLookLikeUserFailure(job, step => step.name.toLowerCase().includes("(nonretryable)"))
      }

      // for builds, don't rerun if it failed on the actual build step
      if (job.name.toLocaleLowerCase().startsWith("build") &&
          doesLookLikeUserFailure(job, step => step.name.toLowerCase().startsWith("build"))){
          // we continue our retry checks even if this test passes in case this is a build-and-test job
          return false
      }

      // if no test steps failed, can rerun
      return !doesLookLikeUserFailure(job, step => step.name.toLowerCase().includes("test"))
    });
    if (shouldRetry.length === 0) {
      return;
    }
    if (shouldRetry.length === 1) {
      // if only one should be rerun, just rerun that job
      return await ctx.octokit.rest.actions.reRunJobForWorkflowRun({
        owner,
        repo,
        job_id: shouldRetry[0].id,
      });
    }
    // if multiple jobs need to be rerun, rerun everything that failed
    return await ctx.octokit.rest.actions.reRunWorkflowFailedJobs({
      owner,
      repo,
      run_id: runId,
    });
  });
}
export default retryBot;
