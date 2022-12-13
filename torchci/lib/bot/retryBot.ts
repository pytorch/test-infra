import { Probot } from "probot";

const FAILURE_CONCLUSIONS = ["failure", "cancelled", "timed_out"];

function retryBot(app: Probot): void {
  app.on("workflow_run.completed", async (ctx) => {
    const workflowName = ctx.payload.workflow_run.name;
    const attemptNumber = ctx.payload.workflow_run.run_attempt;
    const allowedWorkflowPrefixes = [
      "lint",
      "pull",
      "trunk",
      "linux-binary",
      "windows-binary"
    ]

    if (
      ctx.payload.workflow_run.conclusion === "success" ||
      attemptNumber > 1 ||
      allowedWorkflowPrefixes.every(
        allowedWorkflow => !workflowName.toLowerCase().includes(allowedWorkflow)
      )
    ) {
      return;
    }
    const owner = ctx.payload.repository.owner.login;
    const repo = ctx.payload.repository.name;
    const runId = ctx.payload.workflow_run.id;

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
    let doesLookLikeInfraFailure = (job, isInfraStep: (step: any) => boolean) => {
      // Ensure that the steps that failed are only infra related steps (e.g. they're not lint, build, test steps)
      return job.steps?.filter(
        // @ts-expect-error
        (step) =>
          step.conclusion !== null &&
          FAILURE_CONCLUSIONS.includes(step.conclusion) &&
          !isInfraStep(step) 
      ).length === 0
    }

    const shouldRetry = failedJobs.filter((job) => {
      // if the job was cancelled, it was probably an infra error, so rerun
      if (job.conclusion === "cancelled") {
        return true;
      }

      // rerun if the linter didn't fail on the actual linting steps
      if (workflowName === "lint" &&
        doesLookLikeInfraFailure(job, step => !step.name.toLowerCase().startsWith("(nonretryable)"))){
          return true
      }

      // for builds, rerun if it didn't fail on the actual build step
      if (job.name.toLocaleLowerCase().startsWith("build") &&
        doesLookLikeInfraFailure(job, step => !step.name.toLowerCase().startsWith("build"))){
          return true
      }

      // if no test steps failed, can rerun
      if (doesLookLikeInfraFailure(job, step => !step.name.toLowerCase().includes("test"))){
        return true;
      }
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
    // if multiple jobs need to be rerun, rerun everyting that failed
    return await ctx.octokit.rest.actions.reRunWorkflowFailedJobs({
      owner,
      repo,
      run_id: runId,
    });
  });
}
export default retryBot;
