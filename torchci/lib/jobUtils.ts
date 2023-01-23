import { JobData } from "lib/types";

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
