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

export async function isFlaky(
  owner: string,
  repo: string,
  failedJob: any
): Promise<boolean> {
  const id = failedJob.id;

  // By default, consider the failure as not flaky
  if (id === undefined) {
    return false;
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
          name: "jobId",
          type: "int",
          value: id,
        },
        {
          name: "attempt",
          type: "int",
          value: 1, // If the job was retried and still failed, it wasn't flaky
        },
      ],
    }
  );

  const results = query.results;
  if (results === undefined || results.length === 0) {
    return false;
  }

  // The query returns only flaky job with the exact job ID. So if it has data,
  // it means that the job is flaky
  return true;
}
