import { JobData } from "../lib/types";
import React from "react";

const NOT_SUPPORTED_JOBS = [
  "android",
  "bazel",
  "libtorch",
  "macos",
  "rocm",
];

export default function TestInsightsLink({
  job,
  separator,
}: {
  job: JobData;
  separator: string;
}) {
  if (job === null) {
    return (<span></span>);
  }

  const workflowId = job.htmlUrl?.match(
    // https://github.com/pytorch/pytorch/actions/runs/3228501114/jobs/5284857665
    new RegExp("^.+/(.+)/jobs/.+$")
  )?.[1];

  const jobId = job.logUrl?.match(
    // https://github.com/pytorch/pytorch/actions/runs/3228501114/jobs/5284857665
    new RegExp("^.+/log/(.+)$")
  )?.[1];

  if (workflowId === null || jobId === null) {
    return (<span></span>);
  }

  for (const name of NOT_SUPPORTED_JOBS) {
    if (job.jobName?.includes(name)) {
      return (<span></span>);
    }
  }

  // Only show test insight link for test jobs
  if (!job.jobName?.includes("test")) {
    return (<span></span>);
  }

  return (
    <span>
      {separator}
      <a
        target="_blank"
        rel="noreferrer"
        href={`/test/insights?jobName=${encodeURIComponent(job.jobName)}&workflowId=${workflowId}&jobId=${jobId}`}
      >
        Test insights
      </a>
    </span>
  );
}
