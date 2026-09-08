// Client-side view of a misc.greenlight_pr_state row, for the HUD's own
// surfaces (the trunk HUD's PR column, the commit page, the PR page) -- as
// distinct from greenlightRender.ts, which turns the same row into markdown for
// the Dr.CI comment. The status vocabulary is imported from there rather than
// re-declared: greenlight/tests/test_render_sync.py pins those declarations to
// the Python source, so that file has to stay the one place they are spelled.
//
// The model-authored `message` needs none of greenlightRender's defanging here.
// That defanging exists because the Dr.CI comment is markdown GitHub renders:
// a fence stops the text becoming markup and a zero-width space stops an
// @-mention pinging. React escapes text nodes instead, so the containment is
// structural as long as no consumer routes the message through
// dangerouslySetInnerHTML or a markdown renderer -- none does.
//
// No ClickHouse / Octokit / server-only imports, so this is unit-testable and
// importable from any component.

import { GREENLIGHT_STATUS_LAND } from "lib/greenlight/greenlightRender";

/**
 * One `misc.greenlight_pr_state` row as the `greenlight_pr_states` saved query
 * returns it. Saved queries are untyped (`any[]`), so this is the cast target.
 */
export interface GreenlightPrStateRow {
  pr_number: number;
  status: string;
  reason: string;
  message: string;
  head_sha: string;
  eval_job: string;
  run_id: number;
  version: string;
}

/**
 * Whether this status means GreenLight approved the PR to land without a human
 * review. Only LAND does: every other status -- NO_LAND, the in-flight markers,
 * the retry outcomes, REVERTED -- is either a refusal or an absence of one, and
 * an icon on any of them would read as an endorsement the ledger never made.
 */
export function isGreenlightApproved(
  status: string | undefined | null
): boolean {
  return (status ?? "").trim() === GREENLIGHT_STATUS_LAND;
}

/**
 * Whether `candidate` supersedes `incumbent` under the ledger's read-time
 * selection: highest `run_id`, then latest `version`.
 *
 * Mirrors `state.read_latest_states` (greenlight/src/greenlight/state.py) and
 * the `greenlight_pr_states` saved query. Ordering `run_id` ahead of `version`
 * is what makes it race-proof -- a superseded slower dispatch that finishes with
 * a later `version` still loses to the newer dispatch's higher `run_id`.
 *
 * The saved queries already collapse to one row per key, so this only bites if
 * that ever stops being true. Keeping it explicit is cheap insurance: picking
 * arbitrarily among rows for one key would sooner or later surface an approval
 * that a later review revoked.
 */
export function supersedes(
  candidate: Pick<GreenlightPrStateRow, "run_id" | "version">,
  incumbent: Pick<GreenlightPrStateRow, "run_id" | "version">
): boolean {
  if (candidate.run_id !== incumbent.run_id) {
    return candidate.run_id > incumbent.run_id;
  }
  return candidate.version > incumbent.version;
}

/**
 * Collapse rows to `pr_number -> status`, keeping the authoritative row per PR.
 * Rows with a non-positive PR number are dropped: nothing on the HUD can key off
 * one, and the ledger's own reader never emits one.
 */
export function buildStatusByPr(
  rows: GreenlightPrStateRow[] | undefined
): Map<number, string> {
  const authoritative = new Map<number, GreenlightPrStateRow>();
  for (const row of rows ?? []) {
    const prNumber = Number(row.pr_number);
    if (!Number.isFinite(prNumber) || prNumber <= 0) {
      continue;
    }
    const incumbent = authoritative.get(prNumber);
    if (incumbent === undefined || supersedes(row, incumbent)) {
      authoritative.set(prNumber, row);
    }
  }
  return new Map(
    Array.from(authoritative, ([prNumber, row]) => [prNumber, row.status])
  );
}
