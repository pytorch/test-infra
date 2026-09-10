import { checkRange, MAX_RANGE_DAYS } from "lib/autorevert/rangeLimit";

// The metrics page formats both endpoints with
// `dayjs(...).utc().format("YYYY-MM-DDTHH:mm:ss.SSS")` — a UTC instant carrying
// no zone suffix — so that is the shape these tests use.
function naiveUtc(msSinceEpoch: number): string {
  return new Date(msSinceEpoch).toISOString().replace("Z", "");
}

const DAY_MS = 24 * 60 * 60 * 1000;
const START_MS = Date.parse("2026-01-01T00:00:00.000Z");
const START = naiveUtc(START_MS);

function plusDays(days: number, fromMs: number = START_MS): string {
  return naiveUtc(fromMs + days * DAY_MS);
}

describe("checkRange", () => {
  test("accepts the page's default 30d window", () => {
    expect(checkRange(START, plusDays(30))).toEqual({ ok: true });
  });

  test("accepts exactly the maximum range", () => {
    expect(checkRange(START, plusDays(MAX_RANGE_DAYS))).toEqual({ ok: true });
  });

  // The picker reads the clock twice — `dayjs().subtract(n,"day")` for the
  // start, `dayjs()` for the stop — so its widest option is 365 days plus
  // however many milliseconds elapsed between the two reads. An exact
  // comparison 400s the page's own selection.
  test.each([1, 2, 50, 999])(
    "accepts the maximum range with %i ms of clock skew between the two reads",
    (skewMs) => {
      const start = naiveUtc(START_MS - MAX_RANGE_DAYS * DAY_MS);
      const stop = naiveUtc(START_MS + skewMs);
      expect(checkRange(start, stop)).toEqual({ ok: true });
    }
  );

  test("rejects one day past the maximum", () => {
    const result = checkRange(START, plusDays(MAX_RANGE_DAYS + 1));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(`${MAX_RANGE_DAYS} days`);
  });

  // Zone-less endpoints must be read as UTC. Parsing them as local time would
  // shift the two ends by different amounts whenever they sit either side of a
  // DST change, which is enough to reject an exactly-maximum request. Asserting
  // agreement with the explicitly-zoned form makes this independent of whatever
  // timezone the test runner happens to be in.
  test.each([
    ["2026-01-15T12:00:00.000", MAX_RANGE_DAYS], // Jan -> Jan
    ["2026-08-01T12:00:00.000", 180], // PDT -> PST
    ["2026-02-01T12:00:00.000", 180], // PST -> PDT
  ])(
    "zone-less input at %s is read as UTC, not local",
    (startNaive, spanDays) => {
      const startMs = Date.parse(`${startNaive}Z`);
      const stopNaive = plusDays(spanDays, startMs);

      const zoneless = checkRange(startNaive, stopNaive, spanDays);
      const zoned = checkRange(`${startNaive}Z`, `${stopNaive}Z`, spanDays);

      // Exactly the maximum span, so a one-hour DST skew flips the verdict.
      expect(zoneless).toEqual({ ok: true });
      expect(zoneless).toEqual(zoned);
    }
  );

  test("accepts endpoints that carry an explicit zone", () => {
    expect(
      checkRange("2026-01-01T00:00:00.000Z", "2026-01-31T00:00:00.000Z")
    ).toEqual({ ok: true });
    expect(
      checkRange("2026-01-01T00:00:00.000+00:00", "2026-01-31T00:00:00.000Z")
    ).toEqual({ ok: true });
  });

  test("accepts date-only and minute-precision endpoints", () => {
    expect(checkRange("2026-01-01", "2026-01-31")).toEqual({ ok: true });
    expect(checkRange("2026-01-01T00:00", "2026-01-31T00:00")).toEqual({
      ok: true,
    });
  });

  test("rejects a reversed range", () => {
    const result = checkRange(plusDays(30), START);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("after startTime");
  });

  test("accepts a zero-length range", () => {
    expect(checkRange(START, START)).toEqual({ ok: true });
  });

  test("rejects unparseable or unsupported input", () => {
    // Anything outside the accepted grammar is refused rather than guessed at,
    // so this check and the ClickHouse query cannot read a value differently.
    for (const bad of [
      "not-a-date",
      "2026",
      "2026-01",
      "01/02/2026",
      "2026-13-01",
      "",
    ]) {
      expect(checkRange(bad, plusDays(30)).ok).toBe(false);
      expect(checkRange(START, bad).ok).toBe(false);
    }
  });

  test("honours an explicit maxDays override", () => {
    expect(checkRange(START, plusDays(10), 7).ok).toBe(false);
    expect(checkRange(START, plusDays(5), 7)).toEqual({ ok: true });
  });
});
