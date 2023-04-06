import { Probot } from "probot";
import { getFlakyJobBeforeThisJob } from "../jobUtils";

export const SUCCESS_CONCLUSIONS = ["success"];
export const FAILURE_CONCLUSIONS = ["failure", "cancelled", "timed_out"];
export const ALLOWED_WORKFLOW_PREFIXES: { [key: string]: string[] } = {
  pytorch: ["lint", "pull", "trunk", "linux-binary", "windows-binary"],
  vision: [
    "lint",
    "Build Linux",
    "Build Macos",
    "Build M1",
    "Tests on Linux",
    "Tests on macOS",
  ],
};

async function retryPreviousWorkflow(
  ctx: any,
  owner: string,
  repo: string,
  workflowName: string,
  jobs: any[]
) {
  let prevWorkflowId = 0;
  // When a workflow finishes, we also want to go through all its successful jobs
  // to check if the previous jobs are flaky with the following green (current),
  // red (prev job), green (2-job before) pattern.  If this happens, retrying the
  // previous red job
  const retryJobs: number[] = [];
  for (const job of jobs) {
    const prevFlakyJob = await getFlakyJobBeforeThisJob(
      owner,
      repo,
      workflowName,
      job
    );
    if (
      prevFlakyJob === undefined ||
      prevFlakyJob.prev_job_id === undefined ||
      prevFlakyJob.prev_workflow_id === undefined
    ) {
      continue;
    }

    prevWorkflowId = prevFlakyJob.prev_workflow_id;
    retryJobs.push(prevFlakyJob.prev_job_id);
  }

  if (retryJobs.length === 0) {
    return;
  }

  if (retryJobs.length === 1) {
    // If only one should be rerun, just rerun that job
    return await ctx.octokit.rest.actions.reRunJobForWorkflowRun({
      owner,
      repo,
      job_id: retryJobs[0],
    });
  }

  if (prevWorkflowId === 0) {
    return;
  }

  // If multiple jobs need to be rerun, rerun everything that failed
  return await ctx.octokit.rest.actions.reRunWorkflowFailedJobs({
    owner,
    repo,
    run_id: prevWorkflowId,
  });
}

function retryBot(app: Probot): void {
  app.on("workflow_run.completed", async (ctx) => {
    const workflowName = ctx.payload.workflow_run.name;
    const attemptNumber = ctx.payload.workflow_run.run_attempt;
    const defaultBranch = ctx.payload.repository.default_branch;
    const owner = ctx.payload.repository.owner.login;
    const repo = ctx.payload.repository.name;
    const runId = ctx.payload.workflow_run.id;

    const allowedRepoPrefixes = ALLOWED_WORKFLOW_PREFIXES[repo]
      ? ALLOWED_WORKFLOW_PREFIXES[repo]
      : ALLOWED_WORKFLOW_PREFIXES["pytorch"];

    if (
      ctx.payload.workflow_run.conclusion === "success" ||
      (ctx.payload.workflow_run.conclusion === "cancelled" &&
        ctx.payload.workflow_run.head_branch !== defaultBranch) ||
      attemptNumber > 1 ||
      allowedRepoPrefixes.every(
        (allowedWorkflow) =>
          !workflowName.toLowerCase().includes(allowedWorkflow.toLowerCase())
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

    // Check if we need to retry flaky jobs from the previous workflow
    await retryPreviousWorkflow(
      ctx,
      owner,
      repo,
      workflowName,
      workflowJobs.filter((job) =>
        SUCCESS_CONCLUSIONS.includes(job.conclusion!)
      )
    );

    const failedJobs = workflowJobs.filter((job) =>
      FAILURE_CONCLUSIONS.includes(job.conclusion!)
    );
    if (failedJobs.length > 5) {
      // if you have more than 5 failing jobs, its probably either a real failure, a landrace,
      // or a widespread outage that wouldn't be helped by retries
      return;
    }

    const doesLookLikeUserFailure = (
      job: any,
      isCodeValiationStep: (step: any) => boolean
    ) => {
      // Ensure if any of the steps that failed are not infra related steps (e.g. they're lint, build or test steps)
      return (
        job.steps?.filter(
          // @ts-expect-error
          (step) =>
            step.conclusion !== null &&
            FAILURE_CONCLUSIONS.includes(step.conclusion) &&
            isCodeValiationStep(step)
        ).length > 0
      );
    };

    const retryJobs = failedJobs.filter((job) => {
      // If the job was cancelled on master, it was probably an infra error, so rerun.
      // On other branches, it could have been cancelled for valid reasons, so we won't rerun.
      // Would be good to fine tune this further for non-master branches to differentiate between.
      // retryable and nonretryable cancellations
      if (
        job.conclusion === "cancelled" &&
        ctx.payload.workflow_run.head_branch === defaultBranch
      ) {
        return true;
      }

      // don't rerun if the linter failed on the actual linting steps, which have the nonretryable suffix
      if (workflowName.toLocaleLowerCase() === "lint") {
        return !doesLookLikeUserFailure(job, (step) =>
          step.name.toLowerCase().includes("(nonretryable)")
        );
      }

      // for builds, don't rerun if it failed on the actual build step
      if (
        job.name.toLocaleLowerCase().startsWith("build") &&
        doesLookLikeUserFailure(job, (step) =>
          step.name.toLowerCase().startsWith("build")
        )
      ) {
        // we continue our retry checks even if this test passes in case this is a build-and-test job
        return false;
      }

      // if no test steps failed, can rerun
      return !doesLookLikeUserFailure(job, (step) =>
        step.name.toLowerCase().includes("test")
      );
    });

    if (retryJobs.length === 0) {
      return;
    }

    if (retryJobs.length === 1) {
      // if only one should be rerun, just rerun that job
      return await ctx.octokit.rest.actions.reRunJobForWorkflowRun({
        owner,
        repo,
        job_id: retryJobs[0].id,
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
