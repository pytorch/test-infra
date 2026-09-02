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
function parseStamp(value: unknown): dayjs.Dayjs | undefined {
  if (typeof value !== "string" || value === "") {
    return undefined;
  }
  const parsed = dayjs.utc(value);
  return parsed.isValid() ? parsed : undefined;
}

export function utcStamp(value: string | null | undefined): string {
  const parsed = parseStamp(value);
  // Absence arrives two ways and both are ordinary. join_use_nulls = 0 on this
  // cluster, so a timestamp a LEFT JOIN could not resolve comes back as the
  // epoch; a column a query nulls out explicitly comes back as JSON null, which
  // parseStamp rejects on type before dayjs is reached. Neither may render as a
  // 1970 date or as an Invalid Date.
  if (parsed === undefined || parsed.valueOf() <= 0) {
    return ABSENT;
  }
  return parsed.format(STAMP_FORMAT);
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

// A window whose clamped end is at or before its clamped start selects nothing.
// The picker allows it: a Custom range that ends before the ledger begins has
// its start clamped forward past its own end. Bounds that are absent or
// unparseable answer false — not knowing the window is not the same as knowing
// it is empty.
export function isEmptyWindow(row: any): boolean {
  const start = parseStamp(row?.effective_start);
  const end = parseStamp(row?.effective_end);
  if (start === undefined || end === undefined) {
    return false;
  }
  return end.valueOf() <= start.valueOf();
}

// Span the queries actually ran over, in fractional days, or undefined when
// either clamped bound is absent or unparseable.
export function effectiveWindowDays(row: any): number | undefined {
  const start = parseStamp(row?.effective_start);
  const end = parseStamp(row?.effective_end);
  if (start === undefined || end === undefined) {
    return undefined;
  }
  return end.diff(start, "day", true);
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
  return `${utcStamp(row?.effective_start)} → ${utcStamp(
    row?.effective_end
  )} UTC`;
}

export interface RevertStats {
  // Every revert resolved to a PR. NOT a synonym for total, which is this minus
  // the ghfirst exclusion — naming that one "resolvable" understates the
  // population by however many ghfirst reverts the window held.
  resolvable?: number;
  total?: number;
  landApproved?: number;
  // The rest of the same split: reverts of an approved version that the ghfirst
  // gate removed from landApproved. The two sum to every LAND revert resolved to
  // a PR, and this one is why the rate can read 0.0% with rows in the table.
  landApprovedGhfirst?: number;
  evaluated?: number;
  unattributable?: number;
  ghfirst?: number;
  evaluatedPrs?: number;
  rate?: number;
}

// Undefined means "not reported", NEVER zero. These are whole-window scalars
// riding on every row, so they vanish with the row set — and an empty result is
// exactly the case where reverts can exist and be invisible here.
function countOrUnknown(value: any): number | undefined {
  const parsed = Number(value);
  if (value === null || value === undefined || !Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

// Read from the query's own pre-limit window counts rather than by counting the
// rows it returned. The query ends in a LIMIT, and counting returned rows makes
// the rate wrong under truncation in a way that is not merely a shrink: the
// ORDER BY is newest-first, so the numerator can drop to zero while the
// denominator stays large, collapsing the rate rather than biasing it.
export function revertStats(rows: any[]): RevertStats {
  const scalars = rows[0];
  const landApproved = countOrUnknown(scalars?.land_approved_reverts);
  const evaluatedPrs = countOrUnknown(scalars?.evaluated_prs_total);
  return {
    resolvable: countOrUnknown(scalars?.resolvable_reverts),
    total: countOrUnknown(scalars?.attributable_reverts),
    landApproved,
    landApprovedGhfirst: countOrUnknown(scalars?.land_approved_ghfirst_reverts),
    evaluated: countOrUnknown(scalars?.evaluated_reverts),
    unattributable: countOrUnknown(scalars?.unattributable_reverts),
    ghfirst: countOrUnknown(scalars?.ghfirst_reverts),
    evaluatedPrs,
    // Mixed grain on purpose: the numerator counts revert commits and the
    // denominator counts PRs, so a PR reverted twice contributes twice to a
    // denominator it entered once.
    rate: pctOf(landApproved, evaluatedPrs),
  };
}

// merged_version_approved answers "was the verdict shown issued against the
// commit that actually merged". A row the detectors cannot place counts as
// unresolved rather than as either answer.
//
// Every value the column can hold, declared once for the whole page. The strings
// are the query's, not ours: greenlight_quality_reverts builds them in a multiIf
// and nothing in TypeScript checks values, so a rename server-side would degrade
// both consumers here silently and differently — the table would print the raw
// string while stalenessCounts scored 0 confirmed and 0 stale and the note
// announced total detector failure. test/greenlightQualityColumnSync.test.ts
// pins this set against that multiIf.
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

// Every revert of a version GreenLight approved. Shared by the table and the
// staleness note so the two cannot disagree about the population they describe.
//
// Non-LAND is excluded because staleness only matters where something claims
// "the merged version was approved", and every non-LAND row carries 'unknown'
// by construction — counting those would report rows the question never applied
// to as detector failures.
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
  return revertRows(rows).filter(
    (row) => row?.verdict === GREENLIGHT_STATUS_LAND
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
  const judged = approvedRevertRows(rows);
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
  "Verdict staleness: the verdict shown is the newest GreenLight issued at or before the merge, so it can predate the commit that actually merged.";

// Shared by the revert tile and the reverted table so the two cannot state
// different limitations. Both resolve to the same LAND rows, so the two
// surfaces also report the same counts.
export function staleVerdictNote(rows: any[]): string {
  const counts = stalenessCounts(rows);
  if (counts.total === 0) {
    return STALE_VERDICT_LEAD;
  }
  if (counts.resolved === 0) {
    return `${STALE_VERDICT_LEAD} None of the ${intFormatter(
      counts.total
    )} LAND verdicts here could be placed against its merged version, so the figure is unverified in both directions.`;
  }
  const unplaceable =
    counts.unresolved === 0
      ? ""
      : `, ${intFormatter(counts.unresolved)} not placeable either way`;
  return `${STALE_VERDICT_LEAD} Of the ${intFormatter(
    counts.total
  )} LAND verdicts here: ${intFormatter(
    counts.confirmed
  )} confirmed against the merged version, ${intFormatter(
    counts.stale
  )} stale (${percentUnitsFormatter(counts.stalePct)} of the ${intFormatter(
    counts.resolved
  )} a detector could place)${unplaceable}. Staleness only ever inflates “the merged version was approved”, so read the figure as an upper bound.`;
}
