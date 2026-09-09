// Reading misc.greenlight_pr_state for the HUD's own surfaces. The status
// vocabulary is imported from greenlightRender.ts rather than re-declared:
// test_render_sync.py pins those declarations to the Python source, so that
// file stays the one place they are spelled.
//
// No server-only imports, so this is unit-testable and importable anywhere.

import { GREENLIGHT_STATUS_LAND } from "lib/greenlight/greenlightRender";

/** One `greenlight_trunk_commit_states` row; `sha` is the trunk commit. */
export interface GreenlightTrunkStatusRow {
  sha: string;
  status: string;
}

/** Only LAND means approved; every other status is a refusal or an absence. */
export function isGreenlightApproved(
  status: string | undefined | null
): boolean {
  return (status ?? "").trim() === GREENLIGHT_STATUS_LAND;
}

/** Index `greenlight_trunk_commit_states` rows by trunk sha. */
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

/** Shas reach these helpers from URLs and form values, not just the database. */
export function normalizeSha(sha: string | undefined | null): string {
  return (sha ?? "").trim().toLowerCase();
}
