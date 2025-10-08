import { JobData } from "../../lib/types";
import { SingleWorkflowDispatcher } from "../commit/WorkflowDispatcher";
import LogViewer from "../common/log/LogViewer";
import JobLinks from "./JobLinks";

export default function JobTooltip({
  job,
  sha,
  isAutorevertSignal,
}: {
  job: JobData;
  sha?: string;
  isAutorevertSignal?: boolean;
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
      {isAutorevertSignal && (
        <div style={{ color: "red", fontWeight: "bold" }}>
          This job has been identified as introducing regressions and have been
          flagged for autorevert.
        </div>
      )}
      <div>
        <em>click to pin this tooltip, double-click for job page</em>
      </div>
      <JobLinks job={job} showCommitLink={true} />
      <LogViewer job={job} />
    </div>
  );
}
