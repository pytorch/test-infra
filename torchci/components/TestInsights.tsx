import { JobData } from "../lib/types";

// The following jobs are not supported at the moment because neither the monitoring
// script is running there at the moment (libtorch, bazel, android)
const NOT_SUPPORTED_JOBS = ["android", "bazel", "libtorch"];

export default function TestInsightsLink({
  job,
  separator,
}: {
  job: JobData;
  separator: string;
}) {
  if (job === null) {
    return null;
  }

  if (job.conclusion === "pending") {
    // If the job is pending, there is no test insights available yet
    return null;
  }

  const workflowId =
    job.workflowId ??
    job.htmlUrl?.match(
      // https://github.com/pytorch/pytorch/actions/runs/3228501114/job/5284857665
      new RegExp("^.+/(?<workflowId>\\d+)/job/.+$")
    )?.groups?.workflowId;

  const jobId =
    job.id ??
    job.logUrl?.match(
      // https://ossci-raw-job-status.s3.amazonaws.com/log/9018026324
      new RegExp("^.+/log/(?<jobId>\\d+)$")
    )?.groups?.jobId;

  if (workflowId === null || jobId === null) {
    return null;
  }

  for (const name of NOT_SUPPORTED_JOBS) {
    if (job.jobName?.includes(name)) {
      return null;
    }
  }

  // Only show test insight link for test jobs
  if (!job.jobName?.includes("test")) {
    return null;
  }

  return (
    <span>
      {separator}
      <a
        target="_blank"
        rel="noreferrer"
        href={`/test/insights?jobName=${encodeURIComponent(
          job.jobName
        )}&workflowId=${workflowId}&jobId=${jobId}`}
      >
        Test insights
      </a>
    </span>
  );
}
