import { AdvisorVerdict } from "lib/advisorVerdictUtils";
import { isJobViableStrictBlocking } from "lib/JobClassifierUtil";
import {
  describeCellRun,
  describeRunIdentity,
  describeRunOrigin,
  detailJobForRun,
  runKeyOf,
} from "lib/mergeCellRuns";
import { useState } from "react";
import { JobData } from "../../lib/types";
import { SingleWorkflowDispatcher } from "../commit/WorkflowDispatcher";
import LogViewer from "../common/log/LogViewer";
import AdvisorSection from "./AdvisorSection";
import JobConclusion from "./JobConclusion";
import JobLinks from "./JobLinks";

export default function JobTooltip({
  job,
  sha,
  isAutorevertSignal,
  advisorVerdict,
  repoOwner,
  repoName,
  pinCell,
}: {
  job: JobData;
  sha?: string;
  isAutorevertSignal?: boolean;
  advisorVerdict?: AdvisorVerdict;
  repoOwner?: string;
  repoName?: string;
  // Pin this cell's tooltip open, so a choice made in it survives the pointer leaving the cell. The
  // caller owns the pinning policy; this component only says when the reader has acted. Passed in
  // rather than read from PinnedTooltipContext so this component keeps no dependency on the HUD page.
  pinCell?: () => void;
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

  // One radio group per CELL. Two tooltips can be mounted at once -- a pinned one and a hovered one
  // -- and a shared `name` would let picking a run in one clear the selection rendered in the other,
  // since a radio group is global to the document.
  const radioGroup = `cellRuns ${cellKey}`;

  const active =
    selection.cell === cellKey ? selection : { cell: cellKey, showAll: false };

  function pickRun(runKey: string) {
    setSelection({ cell: cellKey, runKey, showAll: active.showAll });
    // A choice has to outlive the pointer. An UNPINNED tooltip is mounted only while the cell is
    // hovered (TooltipTarget), so it unmounts on mouse-out and takes this component's state with it --
    // picking a run then looked like nothing had happened, because by the time the reader looked at
    // the detail area the selection no longer existed. Clicking a run cannot pin via the cell's own
    // handler either: these rows must stop propagation to keep a double-click from navigating.
    pinCell?.();
  }
  const selectedRun = cellRuns?.find((run) => runKeyOf(run) === active.runKey);
  const detailJob = detailJobForRun(job, selectedRun);

  // The run the detail area is describing: the picked one, or the representative while nothing has
  // been picked -- the same rule the radios are checked by, so the two cannot disagree.
  const shownRun = selectedRun ?? cellRuns?.find((run) => run.isRepresentative);
  const shownIdentity = shownRun ? describeRunIdentity(shownRun) : "";

  // Long tails exist -- one cell on a real page merges 82 runs -- and an unbounded list would push
  // the log viewer off the tooltip. Collapse the RENDERING only, never the payload, which would hide
  // the very failure that explains the cell. The list is ordered representative-then-failures, so
  // what the reader most needs is never in the collapsed tail.
  const collapsedRunCount = 5;
  let visibleRuns =
    cellRuns == null || active.showAll
      ? cellRuns
      : cellRuns.slice(0, collapsedRunCount);
  // A run picked before a grid refresh can land in the collapsed tail afterwards: the list is rebuilt
  // and re-ordered from fresh data. Keep it rendered, or the detail area would describe a run with no
  // checked radio anywhere on screen (DP17, gpt-5.6-sol).
  if (
    visibleRuns != null &&
    selectedRun != null &&
    !visibleRuns.includes(selectedRun)
  ) {
    visibleRuns = [...visibleRuns, selectedRun];
  }

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
            {`${cellRuns.length} runs for this commit — the cell's status combines all of them:`}
            {/* RADIO BUTTONS, not links. These change what the rest of the tooltip describes, and a
                link is a promise to navigate: the anchors this replaced read as "open this run" while
                doing something else entirely (Ivan, 2026-08-17). Navigation now has its own affordance
                per row -- the `gh` link -- so the two behaviours are no longer wearing one control.

                The surrounding cell pins on click and opens the job page on DOUBLE click, and
                dblclick bubbles separately from click -- so stopping click alone would still let a
                double-click on a run navigate away while toggling the selection twice. */}
            <div
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              {visibleRuns.map((run) => {
                const key = runKeyOf(run);
                // Checked = the run the detail area is describing, decided by `shownRun` rather than
                // re-derived here. Keyed off the RESOLVED run, not off `active.runKey` alone: a stale
                // key (its run gone after a refresh) would otherwise leave the group with nothing
                // checked while the detail area described the representative (DP17, gpt-5.6-sol).
                const isSelected = run === shownRun;
                return (
                  <div
                    key={key}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.3em",
                    }}
                  >
                    {/* The `gh` link is OUTSIDE the label: nesting a link inside it puts the link's
                        text into the radio's accessible name, and the row's own name comes from
                        aria-label below. */}
                    <label
                      // A mouse convenience only. What the row no longer spells out is rendered for
                      // the INSPECTED run below the list, because a title is unreachable on touch and
                      // a screen reader skips it once the row has visible text (DP17, gpt-5.6-sol).
                      title={describeCellRun(run)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.3em",
                        cursor: "pointer",
                      }}
                    >
                      <input
                        type="radio"
                        name={radioGroup}
                        checked={isSelected}
                        // The visible text is the ORIGIN, which two runs can share -- a periodic job
                        // scheduled twice gives two rows reading "schedule". The full description is
                        // what distinguishes them for a screen reader (DP17, gpt-5.6-sol).
                        aria-label={describeCellRun(run)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => pickRun(key)}
                      />
                      {/* The grid's own status glyph, via the grid's own component -- so a run reads
                        the same way in the tooltip as a cell does on the HUD, monster sprites
                        included when that setting is on. `failedPreviousRun` is deliberately not
                        passed: flakiness is a property of the SET, and marking a single run "F"
                        would say something false about it. */}
                      <JobConclusion
                        conclusion={run.conclusion}
                        // Truthiness, matching what mergeCellRuns carries: fetchHud deletes an empty
                        // `failureAnnotation` before the merge, so '' never reaches a run here -- and
                        // testing `!= null` while the carrier drops '' would be the one combination
                        // that can disagree with itself (DP17, gpt-5.6-sol).
                        classified={!!run.failureAnnotation}
                        jobData={{
                          failureLines: run.failureLines,
                        }}
                      />
                      <span
                        style={{ fontWeight: isSelected ? "bold" : "normal" }}
                      >
                        {describeRunOrigin(run)}
                      </span>
                    </label>
                    {run.htmlUrl && (
                      <a
                        href={run.htmlUrl}
                        target="_blank"
                        rel="noreferrer"
                        title="open this run on GitHub"
                        onClick={(e) => e.stopPropagation()}
                      >
                        gh
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
            {!active.showAll && cellRuns.length > visibleRuns.length && (
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
                {/* Counted against what is actually on screen, not against the collapse limit: a
                    selected run pulled out of the tail above makes those two differ by one. */}
                {`show ${cellRuns.length - visibleRuns.length} more`}
              </a>
            )}
            {/* The dispatch identity of the run being inspected -- attempt, who dispatched it, who
                re-ran it. Rendered once, here, rather than on every row: that is what let the rows
                shrink to one line each, and it keeps the information out of a `title` attribute
                that touch and screen readers cannot reach. Absent for ordinary runs, which have no
                identity to report. */}
            {shownIdentity !== "" && <div>{shownIdentity}</div>}
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
