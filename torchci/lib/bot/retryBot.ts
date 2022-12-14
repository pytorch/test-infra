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
      ctx.payload.workflow_run.head_branch !== "master" ||
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
    const shouldRetry = failedJobs.filter((job) => {
      // always rerun lint
      if (workflowName === "lint") {
        return true;
      }
      // if the job was cancelled, it was probably an infra error, so rerun
      if (job.conclusion === "cancelled") {
        return true;
      }
      // if no test steps failed, can rerun
      if (
        job.steps?.filter(
          (step) =>
            step.conclusion !== null &&
            step.name.toLowerCase().includes("test") &&
            FAILURE_CONCLUSIONS.includes(step.conclusion)
        ).length === 0
      ) {
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
