// Widest range the autorevert metrics page's picker offers.
export const MAX_RANGE_DAYS = 365;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// A selection of exactly MAX_RANGE_DAYS does not arrive as exactly that many
// milliseconds, for two independent reasons, so the comparison below is given a
// full day of grace rather than an exact bound:
//
//   1. `dayjs().subtract(n, "day")` is CALENDAR arithmetic — it preserves the
//      local wall-clock time, so across a DST anniversary the elapsed span is
//      n days ±1h. Measured in America/Los_Angeles: a "Last Year" selection
//      made on 2026-11-01 spans 365 days + 1h, because 2025-11-01 was still
//      PDT while 2026-11-01 is already PST.
//   2. TimeRangePicker reads the clock TWICE — once for the start, once for the
//      stop (pages/metrics.tsx) — so the span also carries however many
//      milliseconds elapsed between the two reads.
//
// This cap exists to stop UNBOUNDED ranges reaching ClickHouse, not to police
// 365 against 366, so a day of grace costs nothing it was meant to protect and
// removes a whole class of calendar-arithmetic false rejections.
const RANGE_GRACE_MS = 24 * 60 * 60 * 1000;

export type RangeCheck = { ok: true } | { ok: false; error: string };

// Accepted shapes: a date, optionally with a time to minute/second/fractional
// precision, optionally with an explicit zone. Anything else is rejected rather
// than guessed at, so that what this function measures and what ClickHouse is
// later asked for cannot drift apart.
const TIMESTAMP_RE =
  /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?(Z|[+-]\d{2}:?\d{2})?$/;

// The metrics page sends UTC instants formatted WITHOUT a zone suffix
// (`startTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS")`). Date.parse reads a
// zone-less date-time as LOCAL, and because the two endpoints of a long window
// can sit either side of a DST change they would then shift by different
// amounts — enough on its own to push an exactly-maximum request over the
// limit. Read zone-less input as UTC, which is what the page meant.
function parseTimestamp(value: unknown): number {
  // A repeated query param (`?startTime=a&startTime=b`) arrives as string[],
  // and this runs before the handler's try block, so a bare .trim() on it would
  // surface as a 500 rather than the 400 this function exists to return.
  if (typeof value !== "string") return NaN;
  const m = TIMESTAMP_RE.exec(value.trim());
  if (!m) return NaN;
  const [, date, time, zone] = m;
  return Date.parse(`${date}T${time ?? "00:00:00"}${zone ?? "Z"}`);
}

/**
 * Validate a metrics time range before it reaches ClickHouse.
 *
 * The recovery pipeline's cost scales with the number of trunk commits in the
 * window, so an unbounded range puts a multi-minute, multi-GB query on the
 * shared ClickHouse user the rest of the HUD also depends on.
 *
 * The picker's PRESETS stop at a year, but its Custom option takes two free
 * date pickers, so an over-long range is a normal UI interaction and not only a
 * hand-edited URL. This is the backstop for both; the page should still bound
 * or surface it client-side, since a 400 here currently renders as an empty
 * page rather than a message.
 */
export function checkRange(
  startTime: unknown,
  stopTime: unknown,
  maxDays: number = MAX_RANGE_DAYS
): RangeCheck {
  const start = parseTimestamp(startTime);
  const stop = parseTimestamp(stopTime);

  if (!Number.isFinite(start) || !Number.isFinite(stop)) {
    return { ok: false, error: "startTime and stopTime must be valid dates" };
  }
  if (stop < start) {
    return { ok: false, error: "stopTime must be after startTime" };
  }
  if (stop - start > maxDays * MS_PER_DAY + RANGE_GRACE_MS) {
    return { ok: false, error: `Time range must be at most ${maxDays} days` };
  }
  return { ok: true };
}
