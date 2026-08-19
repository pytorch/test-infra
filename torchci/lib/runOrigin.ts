/**
 * Naming a CI run in prose.
 *
 * A dependency-free leaf ON PURPOSE. Two surfaces need this vocabulary -- the HUD cell tooltip
 * (through `mergeCellRuns`) and the commit page's run picker (through `WorkflowBox`) -- and putting
 * it in either one's module drags HUD cell aggregation and React components into the other's
 * dependency graph. Concretely, hanging it off `lib/jobUtils` produces a real cycle:
 * `jobUtils -> mergeCellRuns -> JobClassifierUtil -> jobUtils` (DP17, gpt-5.6-sol). Keep this file
 * importing nothing.
 */

/**
 * `runOrigin` is ABSENT only for a run whose workflow event is literally `push`; every other event
 * (schedule, a non-trunk workflow_dispatch, ...) carries its event name, so this never guesses.
 *
 * A BLANK value is a third case and not the same claim: `workflow_event` is a dictGet over
 * workflow_run_dict, so it returns the column default until the dictionary catches up -- the
 * query's own comment says it "takes some time to populate", which means blanks land on the
 * FRESHEST rows, i.e. the top of the HUD. Reporting those as "push" would be a guess, and
 * reporting them as "" rendered the tooltip as `Shown run: .`
 *
 * Normalized here rather than in SQL on purpose. `nullIf` in the query would map a blank onto the
 * NULL that already means "push", re-introducing the guess; and this guards every producer of a
 * JobData, not just hud_query.
 *
 * `null` is accepted alongside `undefined` because commit_jobs_query ships the column as a real
 * SQL NULL, where hud_query's rows reach the client with the key stripped.
 */
export function describeRunOrigin(run: { runOrigin?: string | null }): string {
  if (run.runOrigin === "autorevert") return "autorevert restart";
  if (run.runOrigin === "retry") return "re-run attempt";
  if (run.runOrigin == null) return "push";
  const origin = run.runOrigin.trim();
  return origin === "" ? "unknown" : origin;
}

/**
 * Name a workflow run for the commit page's run picker, which otherwise offers bare numeric ids
 * that nothing distinguishes -- the question asked of it in review was literally "which one of
 * these was the autorevert restart?".
 *
 * EVERY run gets named, including a plain push, so a reader scanning a handful of entries compares
 * like with like instead of inferring from an absence. That is the opposite trade from the HUD
 * grid, where an origin on every one of thousands of rows would be noise -- which is why
 * `hud_query` leaves a push's origin NULL and this does not.
 *
 * It does NOT distinguish "ordinary push" from "origin missing": both render "push", because
 * `describeRunOrigin` cannot tell a genuine NULL from an absent key (DP17, gpt-5.6-sol). Only a
 * BLANK origin is called out, as "unknown".
 *
 * NO ACTOR IS NAMED, and that is a decision rather than an omission. "autorevert restart by
 * pytorch-auto-revert[bot]" says autorevert twice (Ivan, 2026-08-19). Naming the actor INSTEAD of
 * the origin was the alternative, and it is wrong here: actor and origin are independent facts, so
 * a person hand-dispatching a trunk/<sha> run would read "dispatched by <person>" with the
 * autorevert nature invisible — the one thing the label exists to show (DP17, gpt-5.6-sol). The
 * origin alone is the smaller and stronger answer. If the picker ever shows actors for the whole
 * workflow_dispatch family, revisit: naming both then stops being redundant.
 *
 * "dispatch" rather than the tooltip's "restart" because this list enumerates the workflow RUNS
 * behind a commit, where what matters is that the run was dispatched rather than pushed.
 */
export function describeWorkflowRun(run: {
  runOrigin?: string | null;
}): string {
  if (run.runOrigin === "autorevert") return "autorevert dispatch";
  return describeRunOrigin(run);
}
