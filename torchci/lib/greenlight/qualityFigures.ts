// Turning GreenLight quality query rows into the figures the page displays.

import { intFormatter } from "components/common/numberFormat";
import { durationDisplay } from "components/common/TimeUtils";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { GREENLIGHT_STATUS_LAND } from "lib/greenlight/greenlightRender";

dayjs.extend(utc);

const STAMP_FORMAT = "YYYY-MM-DD HH:mm";

export const NO_DATA_IN_WINDOW = "No data in window";

// Rendered wherever a value is absent, so an empty cell always means a rendering
// fault rather than a fact about the data. One constant across the page: the
// table's own formatters and this module's must not drift to different marks.
export const ABSENT = "-";

// The queries hand back percentages already scaled to 0-100, unlike the 0-1
// fractions components/flakyTrunk/common.ts formats. Passing one to the other's
// formatter is off by 100x and still renders a plausible-looking figure, so the
// two names are kept far apart on purpose.
export function percentUnitsFormatter(
  value: number | null | undefined
): string {
  const parsed = Number(value);
  if (value === null || value === undefined || !Number.isFinite(parsed)) {
    return ABSENT;
  }
  return `${parsed.toFixed(1)}%`;
}

export function secondsFormatter(value: number | null | undefined): string {
  const parsed = Number(value);
  if (value === null || value === undefined || !Number.isFinite(parsed)) {
    return ABSENT;
  }
  return durationDisplay(parsed);
}

// dayjs.utc(undefined) is NOT invalid — it returns the current time, so a guard
// written against the parsed result never fires for an absent field and silently
// substitutes "now". Absence has to be rejected on the input.
export function parseStamp(value: unknown): dayjs.Dayjs | undefined {
  if (typeof value !== "string" || value === "") {
    return undefined;
  }
  const parsed = dayjs.utc(value);
  return parsed.isValid() ? parsed : undefined;
}

// Absence arrives two ways and both are ordinary. join_use_nulls = 0 on this
// cluster, so a timestamp a LEFT JOIN could not resolve comes back as the
// epoch; a column a query nulls out explicitly comes back as JSON null, which
// parseStamp rejects on type before dayjs is reached. Neither may render as a
// 1970 date or as an Invalid Date.
function stampText(parsed: dayjs.Dayjs | undefined): string {
  if (parsed === undefined || parsed.valueOf() <= 0) {
    return ABSENT;
  }
  return parsed.utc().format(STAMP_FORMAT);
}

export function utcStamp(value: string | null | undefined): string {
  return stampText(parseStamp(value));
}

export function formatUtcSpan(
  start: dayjs.Dayjs | undefined,
  end: dayjs.Dayjs | undefined
): string {
  return `${stampText(start)} → ${stampText(end)} UTC`;
}

// Undefined, NEVER zero, for a value that is absent or not a finite number, so a
// figure nobody reported cannot pass for a measured 0.
export function finiteNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  if (value === null || value === undefined || !Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

// Whether a tile's own n/denominator column carries anything to report. Drives
// the explicit empty state: an empty window makes every one of these zero, and
// rendering "0.0%" there states a measurement that was never taken.
export function hasCount(value: any): boolean {
  const parsed = Number(value);
  return (
    value !== null &&
    value !== undefined &&
    Number.isFinite(parsed) &&
    parsed > 0
  );
}

export function pctOf(
  numerator: number | null | undefined,
  denominator: number | null | undefined
): number | undefined {
  const n = Number(numerator);
  const d = Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) {
    return undefined;
  }
  return (n / d) * 100;
}

// The clamped bounds the queries actually ran over, or undefined when either is
// absent or unparseable.
export function effectiveWindow(
  row: any
): { start: dayjs.Dayjs; end: dayjs.Dayjs } | undefined {
  const start = parseStamp(row?.effective_start);
  const end = parseStamp(row?.effective_end);
  return start === undefined || end === undefined ? undefined : { start, end };
}

// A window whose clamped end is at or before its clamped start selects nothing.
// The picker allows it: a Custom range that ends before the ledger begins has
// its start clamped forward past its own end. Bounds that are absent or
// unparseable answer false — not knowing the window is not the same as knowing
// it is empty.
export function isEmptyWindow(row: any): boolean {
  const bounds = effectiveWindow(row);
  return bounds !== undefined && bounds.end.valueOf() <= bounds.start.valueOf();
}

// effectiveWindow's span in fractional days.
export function effectiveWindowDays(row: any): number | undefined {
  const bounds = effectiveWindow(row);
  return bounds === undefined
    ? undefined
    : bounds.end.diff(bounds.start, "day", true);
}

// The picker's window is clamped server-side to the ledger's span, so the
// window a user asked for and the window they got are different things.
export function formatEffectiveWindow(row: any): string {
  if (row === undefined) {
    return ABSENT;
  }
  if (isEmptyWindow(row)) {
    return NO_DATA_IN_WINDOW;
  }
  return formatUtcSpan(
    parseStamp(row?.effective_start),
    parseStamp(row?.effective_end)
  );
}

export interface RevertStats {
  // Every revert resolved to a PR. NOT a synonym for total, which is this minus
  // the ghfirst exclusion — naming that one "resolvable" understates the
  // population by however many ghfirst reverts the window held.
  resolvable?: number;
  total?: number;
  landApproved?: number;
  // Reverts the rate would count but for the ghfirst gate. The table lists them,
  // which is why the rate can read 0.0% with rows beneath it.
  landApprovedGhfirst?: number;
  // Reverts carrying a GreenLight LAND whose verdict, by mergebot's own merge
  // record, predates the commit that merged, whatever their classification.
  // Neither the rate nor the table counts them. With landApproved and
  // landApprovedGhfirst they sum to every revert carrying a GreenLight LAND that
  // resolved to a PR.
  landApprovedStale?: number;
  evaluated?: number;
  unattributable?: number;
  ghfirst?: number;
  evaluatedPrs?: number;
  rate?: number;
}

// Read from the query's own pre-limit window counts rather than by counting the
// rows it returned. The query ends in a LIMIT, and counting returned rows makes
// the rate wrong under truncation in a way that is not merely a shrink: the
// ORDER BY is newest-first, so the numerator can drop to zero while the
// denominator stays large, collapsing the rate rather than biasing it.
//
// A count missing from the result stays undefined rather than reading 0. These
// whole-window scalars ride on every row, so they vanish with the row set — and
// an empty result is exactly the case where reverts can exist and be invisible
// here.
export function revertStats(rows: any[]): RevertStats {
  const scalars = rows[0];
  const landApproved = finiteNumber(scalars?.land_approved_reverts);
  const evaluatedPrs = finiteNumber(scalars?.evaluated_prs_total);
  return {
    resolvable: finiteNumber(scalars?.resolvable_reverts),
    total: finiteNumber(scalars?.attributable_reverts),
    landApproved,
    landApprovedGhfirst: finiteNumber(scalars?.land_approved_ghfirst_reverts),
    landApprovedStale: finiteNumber(scalars?.land_approved_stale_reverts),
    evaluated: finiteNumber(scalars?.evaluated_reverts),
    unattributable: finiteNumber(scalars?.unattributable_reverts),
    ghfirst: finiteNumber(scalars?.ghfirst_reverts),
    evaluatedPrs,
    // Mixed grain on purpose: the numerator counts revert commits and the
    // denominator counts PRs, so a PR reverted twice contributes twice to a
    // denominator it entered once.
    rate: pctOf(landApproved, evaluatedPrs),
  };
}

// merged_version_approved answers "was the verdict shown issued against the
// commit that actually merged", and answers no only on mergebot's own merge
// record. A row the detectors cannot place, or one only the branch history
// contradicts, reads 'unknown', which is neither answer: it is kept rather than
// excluded as stale, and counts toward the staleness note's total but never its
// stale count.
//
// Every value the column can hold, declared once for the whole page. The strings
// are the query's, not ours: greenlight_quality_reverts builds them in a multiIf
// and nothing in TypeScript checks values, so a rename server-side would degrade
// both consumers here silently and differently — the table would list the stale
// reverts it is meant to drop, under the raw string, while stalenessCounts scored
// 0 stale and the note reported nothing excluded.
// test/greenlightQualityColumnSync.test.ts pins this set against that multiIf.
export const MERGED_VERSION_APPROVED = {
  yes: "yes",
  no: "no",
  unknown: "unknown",
} as const;

// A window that held no reverts at all still comes back with one row, so the window
// counts have something to ride on — a quiet day is the best outcome this metric can
// report and must not render as missing data. That row is not a revert: it carries an
// empty revert_sha and zeroes, and nothing that counts or lists reverts may include it.
export function isWindowAnchorRow(row: any): boolean {
  return !row?.revert_sha;
}

export function revertRows(rows: any[]): any[] {
  return rows.filter((row) => !isWindowAnchorRow(row));
}

// Every revert carrying a GreenLight LAND, stale or not. The staleness note
// counts this set and the table's rows are cut from it, so the note's stale count
// is exactly the part of it the table leaves out.
//
// Non-LAND is excluded because staleness only matters where something claims
// "the merged version was approved", and every non-LAND row carries 'unknown'
// by construction — counting those would pad the note's total with rows the
// question never applied to.
function landRevertRows(rows: any[]): any[] {
  return revertRows(rows).filter(
    (row) => row?.verdict === GREENLIGHT_STATUS_LAND
  );
}

// The reverts carrying a GreenLight LAND that the table lists. A stale one is
// dropped, as the rate's land_approved_reverts drops it server-side: mergebot's
// own merge record shows its verdict was issued against an earlier commit, so the
// approval never covered what landed. An unverified one stays, as it does in the
// rate: either no detector could place the merged commit, or only the branch
// history contradicts the verdict, and neither proves the approval missed it.
//
// A reverter's classification is NOT excluded here, so this set is deliberately
// wider than the rate's land_approved_reverts, which drops ghfirst server-side.
// Keeping a row is not doubt about its classification: a revert can be correctly
// classified against the path that forced it while the cause names something the
// classification never mentions, and those are the rows worth reading. The table
// carries the classification and the reverter's message side by side so that can
// be seen, which is why a table wider than the tile above it is not a
// contradiction — the same call produced both.
export function approvedRevertRows(rows: any[]): any[] {
  return landRevertRows(rows).filter(
    (row) => row?.merged_version_approved !== MERGED_VERSION_APPROVED.no
  );
}

export interface StalenessCounts {
  total: number;
  confirmed: number;
  stale: number;
  resolved: number;
  unresolved: number;
  stalePct?: number;
}

export function stalenessCounts(rows: any[]): StalenessCounts {
  const judged = landRevertRows(rows);
  const confirmed = judged.filter(
    (row) => row?.merged_version_approved === MERGED_VERSION_APPROVED.yes
  ).length;
  const stale = judged.filter(
    (row) => row?.merged_version_approved === MERGED_VERSION_APPROVED.no
  ).length;
  const resolved = confirmed + stale;
  return {
    total: judged.length,
    confirmed,
    stale,
    resolved,
    unresolved: judged.length - resolved,
    stalePct: pctOf(stale, resolved),
  };
}

const STALE_VERDICT_LEAD =
  "The verdict shown is the newest issued before the merge, so it can predate the commit that actually merged. Reverts where it provably does are excluded as stale";

// Shared by the revert tile and the reverted table so the two cannot state
// different limitations. Both build it from the query's unfiltered rows — the
// table's own list has already dropped the stale reverts counted here — so the
// two surfaces also report the same counts.
export function staleVerdictNote(rows: any[]): string {
  return staleVerdictNoteOf(stalenessCounts(rows));
}

export function staleVerdictNoteOf(counts: StalenessCounts): string {
  if (counts.total === 0) {
    return `${STALE_VERDICT_LEAD}.`;
  }
  return `${STALE_VERDICT_LEAD}: ${intFormatter(
    counts.stale
  )} of ${intFormatter(counts.total)} reverts carrying a GreenLight LAND here.`;
}
