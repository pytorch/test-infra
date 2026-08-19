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
 * The login names whoever DISPATCHED the run, which for a restart is the bot. It is deliberately
 * not the person who re-ran an attempt: `workflow_run.actor` is the original dispatcher and is
 * invariant across attempts, while `triggering_actor` differs per attempt. So "attempt 2 ... by
 * <bot>" means the bot started the run, not that the bot pressed re-run.
 */
export function describeWorkflowRun(run: {
  runOrigin?: string | null;
  restartDispatchedBy?: string | null;
}): string {
  const origin = describeRunOrigin(run);
  return run.restartDispatchedBy
    ? `${origin} by ${run.restartDispatchedBy}`
    : origin;
}
