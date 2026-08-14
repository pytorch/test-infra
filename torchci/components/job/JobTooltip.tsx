import { AdvisorVerdict } from "lib/advisorVerdictUtils";
import { isJobViableStrictBlocking } from "lib/JobClassifierUtil";
import { describeRunOrigin } from "lib/mergeCellRuns";
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

  // Compare against the value rather than testing for presence: hud_query normalizes an unmatched
  // LEFT JOIN to null, but a future '' would otherwise make every push run look like a restart.
  const isAutorevertRestart = job.runOrigin === "autorevert";
  const showOrigin = job.runOrigin != null || job.mergedRunCount != null;

  return (
    <div>
      {`[${job.conclusion}] ${job.name}`}
      {showOrigin && (
        <div style={{ color: "gray" }}>
          {`Shown run: ${describeRunOrigin(job)}`}
          {isAutorevertRestart &&
            job.restartRunAttempt != null &&
            ` (attempt ${job.restartRunAttempt})`}
          {job.restartDispatchedBy &&
            `, dispatched by ${job.restartDispatchedBy}`}
          {job.restartRerunBy && `, rerun by ${job.restartRerunBy}`}
          {"."}
          {job.mergedRunCount != null && (
            <div>
              {`Merged ${job.mergedRunCount} runs for this commit — ${job.mergedRuns}.`}
              {/* The cell shows the success, so this is the only route to the failure behind an "F". */}
              {job.mergedFailureUrl && (
                <>
                  {" "}
                  <a
                    href={job.mergedFailureUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    view the failing run
                  </a>
                </>
              )}
            </div>
          )}
        </div>
      )}
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
