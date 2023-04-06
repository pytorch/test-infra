import { JobData } from "lib/types";
import getRocksetClient from "./rockset";
import rocksetVersions from "rockset/prodVersions.json";

export function isFailedJob(job: JobData) {
  return (
    job.conclusion === "failure" ||
    job.conclusion === "cancelled" ||
    job.conclusion === "timed_out"
  );
}

export function isMatchingJobByName(job: JobData, name: string) {
  // Somehow, JobData has both name and jobName field.  They can be populated
  // by different rockset query, so we need to check both
  return (
    (job.name !== undefined && job.name.includes(name)) ||
    (job.jobName !== undefined && job.jobName.includes(name))
  );
}

export function isRerunDisabledTestsJob(job: JobData) {
  // Rerunning disabled tests are expected to fail from time to time depending
  // on the nature of the disabled tests, so we don't want to count them sometimes
  return isMatchingJobByName(job, "rerun_disabled_tests");
}

export function isUnstableJob(job: JobData) {
  return isMatchingJobByName(job, "unstable");
}

export async function getFlakyJobBeforeThisJob(
  owner: string,
  repo: string,
  branch: string,
  workflowName: string,
  job: any
): Promise<any> {
  const id = job.id;

  // By default, consider the failure as not flaky
  if (id === undefined) {
    return;
  }

  const rocksetClient = getRocksetClient();
  const query = await rocksetClient.queryLambdas.executeQueryLambda(
    "commons",
    "flaky_workflows_jobs",
    rocksetVersions.commons.flaky_workflows_jobs,
    {
      parameters: [
        {
          name: "repo",
          type: "string",
          value: `${owner}/${repo}`,
        },
        {
          name: "workflowNames",
          type: "string",
          value: workflowName,
        },
        {
          name: "nextJobId",
          type: "int",
          value: id, // Query the flaky status of the previous job
        },
        {
          name: "branches",
          type: "string",
          value: branch,
        },
        {
          name: "attempt",
          type: "int",
          value: 1, // If the job was retried and still failed, it wasn't flaky
        },
        {
          name: "numHours",
          type: "int",
          value: 4, // Just need to looks back for a few hours for the immediately previous job
        },
      ],
    }
  );

  const results = query.results;
  if (results === undefined || results.length === 0) {
    return;
  }

  // The query returns the previous flaky job. As the job ID is set, there would
  // be only at most one record
  return results[0];
}
