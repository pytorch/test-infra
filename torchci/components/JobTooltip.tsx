import React from "react";
import { JobData } from "../lib/types";
import JobLinks from "./JobLinks";
import LogViewer from "./LogViewer";
import { SingleWorkflowDispatcher } from "./WorkflowDispatcher";

export default function JobTooltip({
  job,
  sha,
}: {
  job: JobData;
  sha?: string;
}) {
  // For nonexistent jobs, just show something basic:
  if (!job.hasOwnProperty("id")) {
    return (
      <div>
        {`[does not exist] ${job.name}`}
        {sha && job.name && (
          <SingleWorkflowDispatcher sha={sha} jobName={job.name} />
        )}
      </div>
    );
  }

  return (
    <div>
      {`[${job.conclusion}] ${job.name}`}
      <div>
        <em>click to pin this tooltip, double-click for job page</em>
      </div>
      <JobLinks job={job} />
      <LogViewer job={job} />
    </div>
  );
}
