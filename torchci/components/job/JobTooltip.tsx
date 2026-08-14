import { AdvisorVerdict } from "lib/advisorVerdictUtils";
import { isJobViableStrictBlocking } from "lib/JobClassifierUtil";
import {
  describeCellRun,
  describeRunOrigin,
  detailJobForRun,
  runKeyOf,
} from "lib/mergeCellRuns";
import { useState } from "react";
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
  // Which of the cell's runs the detail area below describes. Undefined = the cell itself, which is
  // what the grid renders. Selecting a run rebinds the log viewer, the links and the failure
  // classification to it -- on a flaky "F" cell the cell's own fields are the run that PASSED, so
  // without this the failure that made it flaky is not inspectable from the tooltip at all.
  //
  // Keyed by RUN, and scoped to the cell it was chosen in. An index would silently rebind to a
  // different run when the grid refreshes and the run list grows or reorders; and because this
  // component can be reused for another cell, a selection made in one cell must not survive into the
  // next. Storing the cell alongside makes a stale selection resolve to "nothing selected" rather
  // than to the wrong run.
  //
  // Declared ABOVE the does-not-exist early return below: hooks must be called in the same order on
  // every render, and a cell can gain or lose its `id` between renders as the grid refreshes.
  const cellKey = `${job.sha ?? ""} ${job.name ?? ""}`;
  const [selection, setSelection] = useState<{
    cell: string;
    runKey?: string;
    showAll: boolean;
  }>({ cell: cellKey, showAll: false });

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
  const cellRuns = job.cellRuns;
  // Only for a cell with ONE run. When several were merged, the list below names each of them and
  // this line would both duplicate it and mislead: it describes the representative, so "push" would
  // sit above a failed restart on exactly the cells that exist to show the restart.
  const showSingleRunOrigin = job.runOrigin != null && cellRuns == null;

  const active =
    selection.cell === cellKey ? selection : { cell: cellKey, showAll: false };
  const selectedRun = cellRuns?.find((run) => runKeyOf(run) === active.runKey);
  const detailJob = detailJobForRun(job, selectedRun);

  // Long tails exist -- one cell on a real page merges 82 runs -- and an unbounded list would push
  // the log viewer off the tooltip. Collapse the RENDERING only, never the payload, which would hide
  // the very failure that explains the cell. The list is ordered representative-then-failures, so
  // what the reader most needs is never in the collapsed tail.
  const collapsedRunCount = 5;
  const visibleRuns =
    cellRuns == null || active.showAll
      ? cellRuns
      : cellRuns.slice(0, collapsedRunCount);

  return (
    <div>
      {`[${job.conclusion}] ${job.name}`}
      {showSingleRunOrigin && (
        <div style={{ color: "gray" }}>
          {`Run: ${describeRunOrigin(job)}`}
          {isAutorevertRestart &&
            job.restartRunAttempt != null &&
            ` (attempt ${job.restartRunAttempt})`}
          {job.restartDispatchedBy &&
            `, dispatched by ${job.restartDispatchedBy}`}
          {job.restartRerunBy && `, rerun by ${job.restartRerunBy}`}
          {"."}
        </div>
      )}
      {cellRuns != null && visibleRuns != null && (
        <div style={{ color: "gray" }}>
          <div>
            {/* Says the status combines them all, rather than naming one as "shown": the cell's
                conclusion is a function of the whole set, and a mixed cell renders flaky "F" while
                the run supplying its fields passed. */}
            {`${cellRuns.length} runs for this commit — the cell's status combines all of them. Click one to inspect it:`}
            {/* The surrounding cell pins on click and opens the job page on DOUBLE click, and
                  dblclick bubbles separately from click -- so stopping click alone would still let a
                  double-click on a run navigate away while toggling the selection twice. */}
            <ul
              style={{ margin: 0, paddingLeft: "1.2em" }}
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              {visibleRuns.map((run) => {
                const key = runKeyOf(run);
                const isSelected = key === active.runKey;
                return (
                  <li key={key}>
                    <a
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setSelection({
                          cell: cellKey,
                          runKey: isSelected ? undefined : key,
                          showAll: active.showAll,
                        });
                      }}
                      style={{ fontWeight: isSelected ? "bold" : "normal" }}
                    >
                      {describeCellRun(run)}
                    </a>
                    {run.isRepresentative &&
                      " (this cell's duration and default links)"}
                  </li>
                );
              })}
            </ul>
            {!active.showAll && cellRuns.length > collapsedRunCount && (
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setSelection({ ...active, showAll: true });
                }}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
              >
                {`show ${cellRuns.length - collapsedRunCount} more`}
              </a>
            )}
          </div>
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
      {/* detailJob, not job: these describe the SELECTED run when the reader picked one. */}
      <JobLinks job={detailJob} showCommitLink={true} />
      <LogViewer job={detailJob} />
    </div>
  );
}
