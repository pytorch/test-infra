import { JobStatus } from "components/job/GroupJobConclusion";
// Read only inside a function body, for the same initialization-order reason as JobStatus below.
import { getConclusionChar } from "lib/JobClassifierUtil";
import { describeRunOrigin } from "lib/runOrigin";
import { CellRun, JobData } from "./types";

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
function conclusionOf(job: { conclusion?: string }): string {
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
 * Numeric job id, or undefined when there isn't a usable one. `id` is typed as a string but carries
 * a numeric GitHub job id; the reducer this module replaced compared them as strings, which matches
 * numeric order only while every id has the same digit count.
 */
function numericId(job: { id?: string }): number | undefined {
  if (job.id == null) return undefined;
  const n = Number(job.id);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Last-resort ordering key, so no ordering in this module depends on the order the query returned
 * rows in. `hud_query` has no ORDER BY, and ids can be absent, equal or non-numeric -- in which case
 * a comparator that returns 0 leaves the outcome to sort stability, i.e. to the query.
 */
function tiebreakKey(job: {
  id?: string;
  // Nullable because commit_jobs_query ships a real NULL where hud_query strips the key. The
  // `?? ""` below already treats the two identically, so this widening changes no behaviour.
  runOrigin?: string | null;
  conclusion?: string;
  htmlUrl?: string;
}): string {
  return [
    job.id ?? "",
    job.runOrigin ?? "",
    job.conclusion ?? "",
    job.htmlUrl ?? "",
  ].join(" ");
}

/**
 * Re-exported so existing importers (JobTooltip, this module's own callers, the tests) keep
 * working. The definition moved to the dependency-free `lib/runOrigin`, because the commit page's
 * run picker needs the same vocabulary and reaching it from there through this module would create
 * an import cycle -- see that file for the chain.
 */
export { describeRunOrigin };

/**
 * Stable identity of a run within its cell -- a React key, and the handle the tooltip remembers a
 * selection by. Keyed by the run rather than by list position on purpose: a grid refresh can add or
 * reorder runs, and a positional handle would then silently point the detail area at a different
 * run. Falls back to content when `id` is absent (it is optional), which two byte-identical rows
 * would share -- they describe the same run, so that is the right answer.
 */
export function runKeyOf(run: CellRun): string {
  return run.id ?? `- ${tiebreakKey(run)}`;
}

/**
 * One run, as a line for the cell tooltip: "<origin>[ (attempt N)][, dispatched by X][, rerun by
 * Y] -- <conclusion>".
 *
 * Only the autorevert restart's attempt is available to name. A "re-run attempt" line therefore
 * carries no number: hud_query deliberately does not project the job's own run_attempt, because the
 * HUD page reads `runAttempt` when merging crcr rows and depends on it being undefined on this path.
 */
export function describeCellRun(run: CellRun): string {
  let line = describeRunOrigin(run);
  if (run.runOrigin === "autorevert" && run.restartRunAttempt != null) {
    line += ` (attempt ${run.restartRunAttempt})`;
  }
  if (run.restartDispatchedBy) {
    line += `, dispatched by ${run.restartDispatchedBy}`;
  }
  if (run.restartRerunBy) {
    line += `, rerun by ${run.restartRerunBy}`;
  }
  return `${line} — ${conclusionOf(run)}`;
}

/**
 * What a row of the run list renders ON SCREEN: the origin text, plus the CHARACTER the status glyph
 * draws -- `getConclusionChar`, the same function the glyph itself goes through, not the raw
 * conclusion. Those differ, and the difference is the point: every conclusion outside the known set
 * collapses to `U`, so two runs concluding `action_required` and `stale` draw the identical glyph while
 * their conclusion strings do not match (DP17, gpt-5.6-sol).
 *
 * `failedPreviousRun` is not passed, matching the row, which deliberately withholds it -- flakiness is
 * a property of the whole cell rather than of one run.
 *
 * `failureAnnotation` is deliberately NOT part of the signature. It does change the glyph's styling,
 * so it is arguably a visible difference, but a styling difference is a weak thing to rest "the reader
 * can tell these apart" on -- and over-reporting a collision only ever costs a suffix.
 */
function visibleRunSignature(run: CellRun): string {
  return `${describeRunOrigin(run)} ${getConclusionChar(run.conclusion)}`;
}

/**
 * The TEXT a row of the run list presents, so a collision in either counts. Not every way a row
 * presents a run: the `gh` anchor is a third, and it carries its own label rather than a signature
 * here, because a suffix cannot fix a link whose name is the word "gh" on every row.
 *
 * Neither signature dominates the other, which is why both are here rather than just the coarser one:
 *   - `describeCellRun` carries the attempt / dispatcher / rerunner, so two autorevert restarts of one
 *     cell separate under it while both rows still read "autorevert restart" on screen;
 *   - `visibleRunSignature` goes through the glyph, which folds unknown conclusions onto `U` and an
 *     absent conclusion onto `~`, while `conclusionOf` folds absent and empty together -- so two runs
 *     can share a glyph while their descriptions differ, and vice versa.
 */
const RUN_ROW_SIGNATURES: ((run: CellRun) => string)[] = [
  visibleRunSignature,
  describeCellRun,
];

/**
 * Candidate disambiguators, best identification first. Neither is guaranteed to separate a group, which
 * is why `labelsGroupDistinctly` checks the resulting labels rather than assuming a field works:
 *
 *   - `id` is the JOB id, a primary key in `workflow_job`, and it is what the row's `gh` link points
 *     at (`.../actions/runs/<workflowId>/job/<id>`), so it names the thing the link opens.
 *   - `workflowId` is `job.run_id`, which every re-run ATTEMPT of one run SHARES -- so two retries of
 *     the same run carry the same value and it cannot separate them. It is a fallback for rows that
 *     arrive without a job id, not a second opinion.
 */
const RUN_DISAMBIGUATORS: {
  noun: string;
  valueOf: (run: CellRun) => string | undefined;
}[] = [
  { noun: "job", valueOf: (run) => run.id },
  { noun: "run", valueOf: (run) => run.workflowId },
];

function suffixFrom(
  run: CellRun,
  candidate: { noun: string; valueOf: (run: CellRun) => string | undefined }
): string {
  const value = candidate.valueOf(run);
  return value == null || value === "" ? "" : ` (${candidate.noun} ${value})`;
}

/**
 * Whether one candidate makes every row of a colliding group read differently.
 *
 * The test is on the SUFFIXES, not on the underlying values, and that distinction is the whole point:
 * a run the candidate has no value for contributes '' -- which still separates it from a sibling that
 * got a suffix. Requiring every member to carry a value would reject `[{id: "7"}, {}]`, whose two rows
 * read `push` and `push (job 7)` and are perfectly distinguishable (DP17, gpt-5.6-sol).
 */
function labelsGroupDistinctly(
  group: CellRun[],
  candidate: { noun: string; valueOf: (run: CellRun) => string | undefined }
): boolean {
  const suffixes = new Set(group.map((run) => suffixFrom(run, candidate)));
  return suffixes.size === group.length;
}

/**
 * Per-run suffix that makes a cell's run rows tell each other apart. Two different reasons produce '':
 * the row already reads uniquely in its cell, OR it collides and no candidate can label the collision
 * distinctly -- the second is a gap none of the candidates above can close, not a claim the row is
 * unique.
 *
 * Why it is needed: a row shows `describeRunOrigin` and a status glyph, and its hover and accessible
 * text are `describeCellRun` -- all of which collapse to one string for two runs sharing an origin
 * and a conclusion, since the attempt / dispatcher / rerunner that would separate them are absent on
 * every ordinary push or periodic run. That covers a periodic job scheduled twice, two pushes, and
 * two re-run attempts. Over the 50 newest pytorch/pytorch `main` commits it is 1,147 of 2,555
 * multi-run cells, so it is the common case rather than an edge one.
 *
 * An unlabellable group gets no suffix rather than a made-up one: a positional "2 of 3" would be worse
 * than silence, since the list is re-ordered from fresh data on every grid refresh and an ordinal would
 * then silently re-point at a different run.
 *
 * Scoped to COLLIDING rows, not applied to every row, so a cell whose runs already read differently
 * keeps the one-short-line-per-run shape Ivan asked for (2026-08-17: the spelled-out identity on
 * every line was "extremely verbose").
 *
 * What this does NOT promise: that the final rendered strings are globally unique across the cell. It
 * makes each COLLIDING GROUP internally distinct. A suffix could in principle recreate a collision with
 * some third row whose own text happens to end in the same parenthetical -- type-valid, and not
 * reachable from `hud_query`, whose conclusions and ids cannot contain one.
 *
 * The returned Map is keyed by object identity, which is simply the lookup the caller needs per row;
 * `visibleRuns` holds the same references. It is not load-bearing for correctness -- two byte-identical
 * rows compute identical suffixes anyway, since every input to the suffix is one of their equal fields.
 */
export function disambiguateCellRuns(runs: CellRun[]): Map<CellRun, string> {
  const groupsPerSignature = RUN_ROW_SIGNATURES.map((signatureOf) => {
    const groups = new Map<string, CellRun[]>();
    for (const run of runs) {
      const group = groups.get(signatureOf(run));
      if (group === undefined) {
        groups.set(signatureOf(run), [run]);
      } else {
        group.push(run);
      }
    }
    return { signatureOf, groups };
  });

  const suffixes = new Map<CellRun, string>();
  for (const run of runs) {
    // Every run this one is indistinguishable from, under EITHER signature. A union rather than an
    // intersection: colliding in one of the places a row renders is enough to need a suffix, and the
    // chosen candidate then has to label all of them distinctly at once.
    //
    // Two runs of one collision can compute DIFFERENT unions -- A may also collide with C under the
    // other signature while B does not -- and so may pick different candidates. That cannot make their
    // labels equal: each union contains the whole colliding pair, so a candidate accepted for A already
    // labels A and B differently, and two different candidates carry different nouns.
    const indistinguishable = new Set<CellRun>();
    for (const { signatureOf, groups } of groupsPerSignature) {
      const group = groups.get(signatureOf(run));
      if (group !== undefined && group.length > 1) {
        for (const sibling of group) {
          indistinguishable.add(sibling);
        }
      }
    }
    if (indistinguishable.size < 2) {
      suffixes.set(run, "");
      continue;
    }
    const group = Array.from(indistinguishable);
    const chosen = RUN_DISAMBIGUATORS.find((candidate) =>
      labelsGroupDistinctly(group, candidate)
    );
    suffixes.set(run, chosen === undefined ? "" : suffixFrom(run, chosen));
  }
  return suffixes;
}

/**
 * The dispatch identity of a run -- restart attempt, who dispatched it, who re-ran it -- or '' when
 * it has none (every ordinary push or periodic run).
 *
 * Exists so the run list can stay ONE SHORT LINE per row while this information is still rendered
 * for the run being inspected. It used to sit in each row's text, which Ivan called "extremely
 * verbose" (2026-08-17); moving it into a `title` attribute would have been worse than either, since
 * touch devices cannot reach a title at all and a screen reader skips it once the row has visible
 * text of its own.
 */
export function describeRunIdentity(run: CellRun): string {
  const parts: string[] = [];
  if (run.restartRunAttempt != null) {
    parts.push(`attempt ${run.restartRunAttempt}`);
  }
  if (run.restartDispatchedBy) {
    parts.push(`dispatched by ${run.restartDispatchedBy}`);
  }
  if (run.restartRerunBy) {
    parts.push(`rerun by ${run.restartRerunBy}`);
  }
  return parts.join(", ");
}

/**
 * The JobData the tooltip's detail area -- log viewer, links, failure classification -- should
 * render for a selected run, or for the cell itself when nothing is selected.
 *
 * This exists because selecting a run is not enough on its own. `failureLines`,
 * `failureCaptures` and the log URL are all per-run, and the cell carries the REPRESENTATIVE's,
 * which on a flaky "F" cell is the run that PASSED. Rebinding the detail area is what makes the
 * tooltip answer "why is this cell F?" rather than merely naming the runs.
 */
export function detailJobForRun(cell: JobData, run?: CellRun): JobData {
  if (run === undefined) {
    return cell;
  }
  // EVERY run-scoped field is assigned explicitly, rather than spreading `run` over the cell.
  //
  // A spread would be wrong on the only path that matters. `JSON.stringify` drops keys whose value
  // is `undefined`, so the CellRun the browser receives has no key at all for a field the run lacks
  // -- and a spread then leaves the CELL's value standing. Selecting the push run on a flaky "F"
  // cell would show it with the restart's dispatch identity, or a run with no log pointing at the
  // representative's log. In-memory objects still carry those keys, so a test that does not
  // serialize cannot see the difference.
  return {
    ...cell,
    id: run.id,
    workflowId: run.workflowId,
    failureAnnotation: run.failureAnnotation,
    conclusion: run.conclusion,
    htmlUrl: run.htmlUrl,
    logUrl: run.logUrl,
    durationS: run.durationS,
    runOrigin: run.runOrigin,
    restartRunAttempt: run.restartRunAttempt,
    restartDispatchedBy: run.restartDispatchedBy,
    restartRerunBy: run.restartRerunBy,
    failureLines: run.failureLines,
    failureLineNumbers: run.failureLineNumbers,
    failureCaptures: run.failureCaptures,
    failureContext: run.failureContext,
    // A property of the SET, not of any one run: keeping it would mark a single run flaky.
    failedPreviousRun: undefined,
  };
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
    const jobId = numericId(job);
    const bestId = numericId(best);
    if (jobId !== bestId) {
      // A run with no usable id loses to one that has an id rather than being read as id 0, which
      // would have made it beat every real id in the "newest" comparison below.
      if (jobId === undefined) return best;
      if (bestId === undefined) return job;
      return jobId > bestId ? job : best;
    }
    // Equal or both-absent ids: fall back to a content key so the choice does not depend on the
    // order the query happened to return rows in.
    return tiebreakKey(job) > tiebreakKey(best) ? job : best;
  });

  // Always a copy, and always with failedPreviousRun computed rather than inherited -- including on a
  // one-run cell. Returning the input object let a stale flag ride through and render a phantom "F",
  // and let the caller mutate a row it does not own.
  const merged: JobData = { ...representative };

  // Rule 2, evaluated over the whole set, so it holds whichever run happens to be newer. Cancelled
  // runs are excluded from the evidence (see isRealFailureConclusion) but every other run counts,
  // including ones rule 3 discarded.
  const failedPreviousRun =
    conclusionOf(representative) === JobStatus.Success &&
    runs.some((job) => isRealFailureConclusion(conclusionOf(job)));
  if (failedPreviousRun) {
    merged.failedPreviousRun = true;
  } else {
    // DELETED rather than assigned false, and deleted unconditionally so a stale `true` inherited
    // from the representative row still cannot ride through. `false` is not null, so fetchHud's
    // null-strip cannot drop it: assigning it shipped `"failedPreviousRun":false` on ~19,500 of the
    // 20,362 cells on a real HUD page, and every consumer already reads absent as false
    // (JobConclusion defaults it), so those bytes bought nothing.
    delete merged.failedPreviousRun;
  }

  if (runs.length > 1) {
    // Carry every run, including the representative, so the tooltip can name them and bind its
    // detail area to any one of them (see detailJobForRun). One consistent list is easier to reason
    // about than "the cell, plus the others", and it is the only route from a flaky "F" cell to the
    // failure that made it flaky. Set only on genuinely multi-run cells, so the grid payload is
    // untouched for the overwhelming majority.
    //
    // Ordered by what the reader needs first, NOT by class rank: the representative (so the list
    // opens with the run the cell renders), then real failures, then everything else, newest first
    // inside each group. Class rank would have buried the failure that made an "F" cell flaky behind
    // its successes -- and on a cell with many runs the UI collapses the tail, so a class-ranked list
    // could hide both the representative and the failure. One cell on a real page has 82 runs.
    merged.cellRuns = runs
      .slice()
      .sort((a, b) => {
        if (a === b) return 0;
        if (a === representative) return -1;
        if (b === representative) return 1;
        const aFailed = isRealFailureConclusion(conclusionOf(a)) ? 0 : 1;
        const bFailed = isRealFailureConclusion(conclusionOf(b)) ? 0 : 1;
        if (aFailed !== bFailed) return aFailed - bFailed;
        const aId = numericId(a);
        const bId = numericId(b);
        if (aId !== bId) {
          if (aId === undefined) return 1;
          if (bId === undefined) return -1;
          return bId - aId; // newest first
        }
        return tiebreakKey(b).localeCompare(tiebreakKey(a));
      })
      .map((job) => {
        const run: CellRun = {
          // `?? undefined` normalizes at the boundary rather than widening CellRun: a JobData can
          // carry a SQL NULL (commit_jobs_query), a CellRun never does -- it is built only from
          // hud_query rows, whose nulls fetchHud has already stripped. Both spellings mean the
          // same run, so collapsing them here keeps the narrower type honest.
          runOrigin: job.runOrigin ?? undefined,
          conclusion: job.conclusion,
          id: job.id,
          workflowId: job.workflowId,
          htmlUrl: job.htmlUrl,
          logUrl: job.logUrl,
          durationS: job.durationS,
          restartRunAttempt: job.restartRunAttempt,
          restartDispatchedBy: job.restartDispatchedBy ?? undefined,
          restartRerunBy: job.restartRerunBy,
        };
        // Only when there IS one. An unannotated job carries '' rather than null on some producers,
        // and fetchHud strips only nulls -- assigning it unconditionally would ship an empty string
        // on every run of every multi-run cell to say nothing.
        if (job.failureAnnotation) {
          run.failureAnnotation = job.failureAnnotation;
        }
        // Classification text ONLY for runs that actually failed. It is the largest thing a run can
        // carry -- one run on a real page carries 55 KB of it -- and torchci classifies plenty of
        // runs that did not fail: measured over the 50 newest pytorch/pytorch trunk commits, runs on
        // multi-run cells hold 1.35 MB of classification of which just 4.7 KB sits on a run whose
        // conclusion is failure or timed_out. Carrying it unconditionally would add ~1.3 MB to the
        // grid to explain nothing, since the only reason to inspect a sibling run is that it FAILED.
        if (isRealFailureConclusion(conclusionOf(job))) {
          run.failureLines = job.failureLines;
          run.failureLineNumbers = job.failureLineNumbers;
          run.failureCaptures = job.failureCaptures;
          run.failureContext = job.failureContext;
        }
        if (job === representative) {
          run.isRepresentative = true;
        }
        return run;
      });
  }

  return merged;
}
