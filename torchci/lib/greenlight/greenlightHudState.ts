// Reading misc.greenlight_pr_state for the HUD's own surfaces. The status
// vocabulary is imported from greenlightRender.ts rather than re-declared:
// test_render_sync.py pins those declarations to the Python source, so that
// file stays the one place they are spelled.
//
// No server-only imports, so this is unit-testable and importable anywhere.

import { GREENLIGHT_STATUS_LAND } from "lib/greenlight/greenlightRender";

/** One `misc.greenlight_pr_state` row. Saved queries are untyped, so this is the cast target. */
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

/**
 * The ledger's read-time selection: highest `run_id`, then latest `version`.
 * run_id ahead of version is what makes it race-proof against a superseded
 * slower dispatch finishing later.
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

/** Index `greenlight_pr_state_history` rows by the commit they reviewed. */
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

/** The PR's authoritative row -- the one the merge gate acted on. */
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
 * The verdict to show while viewing `sha`: that commit's own if it was
 * reviewed, else the PR's authoritative one. The fallback is the normal path on
 * a commit page -- mergebot rebases, so a landed sha is never a reviewed sha.
 */
export function selectStateForSha(
  rows: GreenlightPrStateRow[] | undefined,
  sha: string | undefined | null
): GreenlightPrStateRow | undefined {
  return (
    buildStateBySha(rows).get(normalizeSha(sha)) ?? authoritativeState(rows)
  );
}
