// Reading misc.greenlight_pr_state for the HUD's own surfaces (the trunk HUD's
// PR column, the commit page, the PR page) -- as distinct from
// greenlightRender.ts, which turns the same row into markdown for the Dr.CI
// comment. The status vocabulary is imported from there rather than
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
// Takes no ClickHouse / Octokit / server-only imports, so it is unit-testable
// and importable anywhere.

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
 * One row of `greenlight_trunk_commit_states`: the verdict GreenLight reached on
 * the exact revision that produced this trunk commit. `sha` is the trunk commit,
 * which the HUD already has on every row.
 */
export interface GreenlightTrunkStatusRow {
  sha: string;
  status: string;
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
 * Collapse `greenlight_trunk_commit_states` rows to `trunk sha -> status`.
 *
 * Keyed by the commit, never by the PR. A PR that lands, is reverted, is
 * changed, and lands again produces two trunk commits from two revisions with
 * two verdicts; keying on the PR would give both commits the later verdict and
 * mark the first with an approval that was never about it. The query already
 * resolves each commit to its own revision, so this only has to index the
 * result.
 */
export function buildStatusByTrunkSha(
  rows: GreenlightTrunkStatusRow[] | undefined
): Map<string, string> {
  const bySha = new Map<string, string>();
  for (const row of rows ?? []) {
    const sha = normalizeSha(row.sha);
    if (sha !== "") {
      bySha.set(sha, row.status);
    }
  }
  return bySha;
}

/**
 * A commit sha in the one form every lookup here uses. Git shas are lowercase
 * hex, but the sha reaching these helpers comes from a URL or a `<select>` value
 * as often as from the database, so normalise rather than assume.
 */
export function normalizeSha(sha: string | undefined | null): string {
  return (sha ?? "").trim().toLowerCase();
}

/**
 * Collapse `greenlight_pr_state_history` rows to `head_sha -> row`, keeping the
 * authoritative row per commit. The query already collapses per head_sha; this
 * re-applies the same selection for the reason `buildStatusByPr` does.
 */
export function buildStateBySha(
  rows: GreenlightPrStateRow[] | undefined
): Map<string, GreenlightPrStateRow> {
  const bySha = new Map<string, GreenlightPrStateRow>();
  for (const row of rows ?? []) {
    const sha = normalizeSha(row.head_sha);
    if (sha === "") {
      continue;
    }
    const incumbent = bySha.get(sha);
    if (incumbent === undefined || supersedes(row, incumbent)) {
      bySha.set(sha, row);
    }
  }
  return bySha;
}

/**
 * The PR's authoritative row across every commit it has been reviewed on -- the
 * one the merge gate acted on and Dr.CI renders. Undefined when the PR has no
 * recorded state at all.
 */
export function authoritativeState(
  rows: GreenlightPrStateRow[] | undefined
): GreenlightPrStateRow | undefined {
  let best: GreenlightPrStateRow | undefined;
  for (const row of rows ?? []) {
    if (best === undefined || supersedes(row, best)) {
      best = row;
    }
  }
  return best;
}

/**
 * Pick the state to show while viewing `sha`: that commit's own verdict when
 * GreenLight reviewed it, otherwise the PR's authoritative verdict. Undefined
 * when the PR has no recorded state at all.
 *
 * The fallback is not a fudge, and it is not rare -- it is the normal path on a
 * commit page. pytorch's mergebot rebases on merge, so a landed trunk commit's
 * sha is never the PR head sha GreenLight reviewed, even though the trunk commit
 * *is* that reviewed change. Verified on pytorch/pytorch#196176: GreenLight
 * approved 2d43869, which is that PR's final head, and 55448714 on main is the
 * same change rebased. Treating that as "some other commit's verdict" was
 * exactly backwards.
 *
 * So the verdict is reported as what it is -- a statement about the PR -- and
 * the caller does not qualify it by which commit is on screen. The per-commit
 * detail lives in the PR page's picker, where `buildStateBySha` marks precisely
 * the pushes GreenLight reviewed.
 */
export function selectStateForSha(
  rows: GreenlightPrStateRow[] | undefined,
  sha: string | undefined | null
): GreenlightPrStateRow | undefined {
  return (
    buildStateBySha(rows).get(normalizeSha(sha)) ?? authoritativeState(rows)
  );
}
