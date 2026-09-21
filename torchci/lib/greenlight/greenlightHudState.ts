// Reading misc.greenlight_pr_state for the HUD's own surfaces. The status
// vocabulary is imported from greenlightRender.ts rather than re-declared:
// test_render_sync.py pins those declarations to the Python source, so that
// file stays the one place they are spelled.
//
// No server-only imports, so this is unit-testable and importable anywhere.

import {
  capCodePoints,
  isOutline,
  ParsedOutline,
  parseOutline,
} from "lib/greenlight/greenlightOutline";
import {
  GREENLIGHT_MESSAGE_CAP,
  GREENLIGHT_STATUS_LAND,
  GREENLIGHT_STATUS_NO_LAND,
} from "lib/greenlight/greenlightRender";
import { CommitData } from "lib/types";

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

/** The commits `greenlight_trunk_commit_states` reads, as arrays it zips by position. */
export interface GreenlightCommitParams {
  shas: string[];
  prNumbers: number[];
  committedAts: string[];
}

/**
 * Build the query's input from the commits the grid is drawing.
 *
 * One pass over the rows, so the three arrays cannot fall out of step: the
 * query zips them positionally, and a misaligned triple would resolve one
 * commit's head against another commit's PR.
 *
 * A row with no PR number is dropped. Neither source the query resolves a
 * reviewed head from is reachable without one, and the mark hangs off the PR
 * cell, which such a row does not render.
 */
export function buildGreenlightCommitParams(
  rows: Pick<CommitData, "sha" | "prNum" | "time">[] | undefined
): GreenlightCommitParams {
  const shas: string[] = [];
  const prNumbers: number[] = [];
  const committedAts: string[] = [];
  for (const row of rows ?? []) {
    if (row.prNum == null || row.prNum <= 0) {
      continue;
    }
    shas.push(row.sha);
    prNumbers.push(row.prNum);
    committedAts.push(row.time);
  }
  return { shas, prNumbers, committedAts };
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

/** How the panel shows a verdict `message`: as a bullet list, or as raw text. */
export type GreenlightMessageView =
  | { kind: "outline"; outline: ParsedOutline }
  | { kind: "text"; text: string };

/**
 * The same two-way choice renderVerdictMessage makes for the Dr.CI comment: a
 * bullet outline becomes a list, everything else stays text. Two of the three
 * routes that renderer takes to the fence are here -- a message that parses to
 * no topic at all, and a parse that throws. The third is not, and the panel
 * claims no parity on it: the comment renderer also falls through when its first
 * item alone overruns OUTLINE_BLOCK_BUDGET, which bounds finished markup in a
 * comment body this surface never builds.
 *
 * The parser reads the raw message, never a capped one. It takes its own prefix
 * and decides `truncated` from the original length, so handing it text already
 * cut to the cap would drop the marker saying the reader is missing the rest.
 *
 * The thrown error is logged without the message beside it: that text is
 * model-authored and PR-influenceable, and a console is not where it gets
 * replayed unbounded.
 */
export function selectMessageView(
  message: string | undefined | null
): GreenlightMessageView {
  // A row is a cast over an untyped saved query, so `message` is a string by
  // assertion alone. Anything else has to become one here: it reaches the panel
  // as a React child, and React renders no object.
  const raw = typeof message === "string" ? message : "";
  try {
    if (isOutline(raw)) {
      const outline = parseOutline(raw);
      if (outline.topics.length > 0) {
        return { kind: "outline", outline };
      }
    }
  } catch (e) {
    console.error("greenlight outline parse threw", e);
  }
  return { kind: "text", text: capCodePoints(raw, GREENLIGHT_MESSAGE_CAP) };
}
