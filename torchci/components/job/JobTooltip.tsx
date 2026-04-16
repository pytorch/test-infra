import { AdvisorVerdict } from "lib/advisorVerdictUtils";
import { isJobViableStrictBlocking } from "lib/JobClassifierUtil";
import { JobData } from "../../lib/types";
import { SingleWorkflowDispatcher } from "../commit/WorkflowDispatcher";
import LogViewer from "../common/log/LogViewer";
import AdvisorSection from "./AdvisorSection";
import JobLinks from "./JobLinks";

export default function JobTooltip({
  job,
  sha,
  isAutorevertSignal,
  advisorVerdict,
  repoOwner,
  repoName,
}: {
  job: JobData;
  sha?: string;
  isAutorevertSignal?: boolean;
  advisorVerdict?: AdvisorVerdict;
  repoOwner?: string;
  repoName?: string;
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

  const isViableStrictBlocking =
    repoOwner &&
    repoName &&
    isJobViableStrictBlocking(job.name, repoOwner, repoName);

  return (
    <div>
      {`[${job.conclusion}] ${job.name}`}
      {isAutorevertSignal && (
        <div style={{ color: "red", fontWeight: "bold" }}>
          Failure in this job has triggered autorevert.
        </div>
      )}
      {advisorVerdict && (
        <AdvisorSection
          verdict={advisorVerdict}
          repoOwner={repoOwner}
          repoName={repoName}
        />
      )}
      {isViableStrictBlocking && (
        <div style={{ color: "orange", fontWeight: "bold" }}>
          This job is viable/strict blocking.
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
