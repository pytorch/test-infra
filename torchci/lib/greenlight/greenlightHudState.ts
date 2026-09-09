// Reading misc.greenlight_pr_state for the HUD's own surfaces (the trunk HUD's
// PR column, the commit page, the PR page) -- as distinct from
// greenlightRender.ts, which turns the same row into markdown for the Dr.CI
// comment. The status vocabulary is imported from there rather than
// re-declared: greenlight/tests/test_render_sync.py pins those declarations to
// the Python source, so that file has to stay the one place they are spelled.
//
// Takes no ClickHouse / Octokit / server-only imports, so it is unit-testable
// and importable anywhere.

import { GREENLIGHT_STATUS_LAND } from "lib/greenlight/greenlightRender";

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
