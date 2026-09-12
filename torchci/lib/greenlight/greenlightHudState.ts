// Reading misc.greenlight_pr_state for the HUD's own surfaces. The status
// vocabulary is imported from greenlightRender.ts rather than re-declared:
// test_render_sync.py pins those declarations to the Python source, so that
// file stays the one place they are spelled.
//
// No server-only imports, so this is unit-testable and importable anywhere.

import {
  GREENLIGHT_STATUS_LAND,
  GREENLIGHT_STATUS_NO_LAND,
} from "lib/greenlight/greenlightRender";

/** One `misc.greenlight_pr_state` row. Saved queries are untyped, so this is the cast target. */
export interface GreenlightPrStateRow {
  pr_number: number;
  status: string;
  reason: string;
  message: string;
  head_sha: string;
  /** The trunk commit `head_sha` landed as, or "" if it never landed. */
  merge_commit_sha: string;
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
 * Only NO_LAND means Green Light looked at the commit and refused it. The other
 * non-LAND statuses are absences, not refusals -- CANCELLED and FAILED mean no
 * verdict was reached, REVERTED means the PR was excluded from review rather
 * than judged, and the in-flight ones mean the review has not finished. Marking
 * any of those as rejected would attribute a judgement that was never made.
 */
export function isGreenlightRejected(
  status: string | undefined | null
): boolean {
  return (status ?? "").trim() === GREENLIGHT_STATUS_NO_LAND;
}

/**
 * Whether the HUD puts a Green Light mark on a commit.
 *
 * Approvals are always marked. Refusals are opt-in and off by default: most of
 * trunk was never approved by Green Light, so marking every refusal turns a
 * sparse signal into a column of red that says little about the commit the
 * reader is looking at. `showRejected` is the reader's own choice to see them.
 */
export function shouldShowGreenlightStatus(
  status: string | undefined | null,
  showRejected: boolean
): boolean {
  return (
    isGreenlightApproved(status) ||
    (showRejected && isGreenlightRejected(status))
  );
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

/**
 * The verdict for `sha`, matched two ways and never guessed:
 *
 * - the reviewed head itself, which is what a PR page's picker selects;
 * - the trunk commit that head landed as, since mergebot rebases and a landed
 *   commit never carries the sha that was reviewed.
 *
 * Undefined when neither matches. There is deliberately no fall back to the
 * PR's latest verdict: on a PR page most picker entries are commits that were
 * never a review head, and showing them another commit's approval says
 * something untrue. It also means a forged "Pull Request resolved: #N" in a
 * commit message resolves to nothing rather than to someone else's approval.
 */
export function selectStateForSha(
  rows: GreenlightPrStateRow[] | undefined,
  sha: string | undefined | null
): GreenlightPrStateRow | undefined {
  const wanted = normalizeSha(sha);
  if (wanted === "") {
    return undefined;
  }
  return (rows ?? []).find(
    (row) =>
      normalizeSha(row.head_sha) === wanted ||
      normalizeSha(row.merge_commit_sha) === wanted
  );
}
