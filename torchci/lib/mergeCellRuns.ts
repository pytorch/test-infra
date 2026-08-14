import { JobStatus } from "components/job/GroupJobConclusion";
import { JobData } from "./types";

/**
 * Merge every run that reported for one (sha, job name) cell into the single JobData the HUD grid
 * renders.
 *
 * The governing invariant is that **who issued a run is irrelevant to aggregation**. A run issued by
 * a push, a GitHub re-run attempt, and an autorevert restart are all just runs; the cell's verdict is
 * a function of the set of conclusions alone -- never of the issuer, and never of the order they
 * arrived in. Origin is reported (see `runOrigin`) but never aggregated on.
 *
 * Rules:
 *   1. One run -> show that run.
 *   2. Success + failure, in any order -> show the success, marked flaky ("F").
 *   3. Cancelled loses to ANY non-cancelled run.
 * plus the pre-existing rule that `skipped` loses to a real result, which is the same shape as rule 3
 * and is preserved.
 *
 * This replaces a newest-id-wins reducer, under which a cell's verdict depended on which run happened
 * to be newer: a natural run that passed followed by a restart that failed rendered as a plain red,
 * while the reverse order rendered as flaky.
 */

// JobStatus is only ever read inside a function body. It lives in a component that transitively
// imports this module, so touching it while this module initializes yields undefined -- the same
// reason JobClassifierUtil only reads it inside a switch.

/**
 * A missing or empty conclusion means the run has not concluded. hud_query already maps '' to
 * queued/pending, so this is defensive normalization for an exported function rather than a live
 * path, but it keeps ranking and display from silently treating '' as an unknown class.
 */
function conclusionOf(job: JobData): string {
  const c = job.conclusion;
  return c === undefined || c === null || c === "" ? JobStatus.Pending : c;
}

/**
 * Conclusions that are evidence the job genuinely failed.
 *
 * Deliberately EXCLUDES `cancelled`, unlike `isFailure()` in JobClassifierUtil. Rule 3 discards a
 * cancelled run whenever any non-cancelled run exists, and a discarded run must not also contribute
 * failure evidence -- a cancellation says nothing about whether the job passes. Consequence, measured
 * over 14 days of pytorch/pytorch: 223 cells that today render "F" purely because a cancelled run
 * sits beside a success become a plain success.
 *
 * This is intended behaviour, confirmed rather than assumed -- do not "fix" it by adding Cancelled
 * back to match isFailure(). If cancellation ever needs to be visible on a cell that also has a
 * success, it wants its own marker rather than overloading the flaky "F".
 */
function isRealFailureConclusion(conclusion: string): boolean {
  return conclusion === JobStatus.Failure || conclusion === JobStatus.Timed_out;
}

function isPendingConclusion(conclusion: string): boolean {
  return conclusion === JobStatus.Queued || conclusion === JobStatus.Pending;
}

/**
 * Priority for which run's identity (links, log, duration) represents the cell. Cancelled is NOT
 * ranked here: rule 3 removes cancelled runs before ranking, so by this point they only survive when
 * every run was cancelled. Ranking cancelled instead of filtering it made it beat `skipped` and
 * `neutral`, which contradicts rule 3.
 *
 * Success outranks failure because rule 2 renders a mixed cell as a flaky success; the flaky flag,
 * not the representative, is what tells the reader a failure happened.
 */
function classRank(job: JobData): number {
  const c = conclusionOf(job);
  if (c === JobStatus.Success) return 0;
  if (isRealFailureConclusion(c)) return 1;
  if (isPendingConclusion(c)) return 2;
  if (c === JobStatus.Neutral) return 3;
  if (c === JobStatus.Skipped) return 4;
  if (c === JobStatus.Cancelled) return 5;
  return 6;
}

/**
 * `runOrigin` is absent only for a run whose workflow event is literally `push`; every other event
 * (schedule, a non-trunk workflow_dispatch, ...) carries its event name, so this never guesses.
 */
export function describeRunOrigin(job: JobData): string {
  if (job.runOrigin === "autorevert") return "autorevert restart";
  if (job.runOrigin === "retry") return "re-run attempt";
  return job.runOrigin ?? "push";
}

export function mergeCellRuns(runs: JobData[]): JobData {
  if (runs.length === 0) {
    return {};
  }

  // Rule 3 as a filter rather than a rank: a cancelled run is discarded outright whenever ANY
  // non-cancelled run exists, so it can never win against skipped or neutral either.
  const nonCancelled = runs.filter(
    (job) => conclusionOf(job) !== JobStatus.Cancelled
  );
  const considered = nonCancelled.length > 0 ? nonCancelled : runs;

  // Best class, then newest inside that class. The id tiebreak is numeric: `id` is typed as a string
  // but carries a numeric GitHub job id, and the reducer this replaced compared them as strings --
  // which matches numeric order only while every id has the same digit count.
  const representative = considered.reduce((best, job) => {
    const d = classRank(job) - classRank(best);
    if (d !== 0) {
      return d < 0 ? job : best;
    }
    return Number(job.id ?? 0) > Number(best.id ?? 0) ? job : best;
  });

  // Always a copy, and always with failedPreviousRun computed rather than inherited -- including on a
  // one-run cell. Returning the input object let a stale flag ride through and render a phantom "F",
  // and let the caller mutate a row it does not own.
  const merged: JobData = { ...representative };

  // Rule 2, evaluated over the whole set, so it holds whichever run happens to be newer. Cancelled
  // runs are excluded from the evidence (see isRealFailureConclusion) but every other run counts,
  // including ones rule 3 discarded.
  merged.failedPreviousRun =
    conclusionOf(representative) === JobStatus.Success &&
    runs.some((job) => isRealFailureConclusion(conclusionOf(job)));

  if (runs.length > 1) {
    // Report what was merged so a reader can see the cell summarizes several runs and where each came
    // from. Set only on genuinely multi-run cells, leaving the grid payload untouched for the
    // overwhelming majority.
    merged.mergedRunCount = runs.length;
    merged.mergedRuns = runs
      .slice()
      .sort(
        (a, b) =>
          classRank(a) - classRank(b) || Number(a.id ?? 0) - Number(b.id ?? 0)
      )
      .map((job) => `${describeRunOrigin(job)}: ${conclusionOf(job)}`)
      .join(", ");

    // Keep the losing failure reachable. Rule 2 makes the SUCCESS the representative, so without this
    // the cell renders "F" while its links all point at the run that passed and the failure the
    // reader actually wants to inspect has no route from the grid.
    const hiddenFailure = runs
      .filter(
        (job) =>
          job !== representative && isRealFailureConclusion(conclusionOf(job))
      )
      .sort((a, b) => Number(b.id ?? 0) - Number(a.id ?? 0))[0];
    if (hiddenFailure?.htmlUrl) {
      merged.mergedFailureUrl = hiddenFailure.htmlUrl;
    }
  }

  return merged;
}
