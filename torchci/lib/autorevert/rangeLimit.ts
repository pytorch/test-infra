// Widest range the autorevert metrics page's picker offers.
export const MAX_RANGE_DAYS = 365;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
function parseTimestamp(value: string): number {
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
 * shared ClickHouse user the rest of the HUD also depends on. The picker caps
 * itself at a year; this exists because a picker limit does not protect the
 * endpoint from a hand-edited URL.
 */
export function checkRange(
  startTime: string,
  stopTime: string,
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
  if (stop - start > maxDays * MS_PER_DAY) {
    return { ok: false, error: `Time range must be at most ${maxDays} days` };
  }
  return { ok: true };
}
