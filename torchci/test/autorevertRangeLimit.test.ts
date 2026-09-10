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

  // `dayjs().subtract(n, "day")` in a browser is CALENDAR arithmetic — it holds
  // the local wall clock — so across a DST anniversary the widest preset
  // arrives as n days ±1h rather than n days exactly. Measured in
  // America/Los_Angeles: a "Last Year" selection made on 2026-11-01 spans
  // 365 days + 1h, because the year-ago instant was still PDT.
  //
  // The server only ever sees two UTC instants, so that is what is asserted
  // here — constructing the span directly keeps this independent of the test
  // runner's own timezone, which is UTC in CI.
  test.each([
    ["an hour long (autumn DST anniversary)", 60 * 60 * 1000],
    ["an hour short (spring DST anniversary)", -60 * 60 * 1000],
    ["exact", 0],
  ])("accepts a widest-preset span that is %s", (_label, skewMs) => {
    const stopMs = START_MS;
    const start = naiveUtc(stopMs - MAX_RANGE_DAYS * DAY_MS - skewMs);
    expect(checkRange(start, naiveUtc(stopMs))).toEqual({ ok: true });
  });

  test("rejects a repeated query param instead of throwing", () => {
    // `?startTime=a&startTime=b` arrives as string[]; this runs before the
    // handler's try block, so throwing here would be a 500 not a 400.
    expect(checkRange(["2026-01-01", "2026-01-02"], START).ok).toBe(false);
    expect(checkRange(START, ["2026-01-01"]).ok).toBe(false);
    expect(checkRange(undefined, START).ok).toBe(false);
    expect(checkRange(START, 1767225600000).ok).toBe(false);
  });

  // One day of grace sits above the maximum to absorb calendar-arithmetic and
  // clock-skew artifacts, so 366 days is deliberately still accepted; the cap
  // exists to stop unbounded ranges, not to police 365 against 366.
  test("accepts one day past the maximum, inside the grace", () => {
    expect(checkRange(START, plusDays(MAX_RANGE_DAYS + 1))).toEqual({
      ok: true,
    });
  });

  test.each([MAX_RANGE_DAYS + 2, MAX_RANGE_DAYS + 30, 5 * 365])(
    "rejects a %i-day range, which is past the grace",
    (days) => {
      const result = checkRange(START, plusDays(days));
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toContain(`${MAX_RANGE_DAYS} days`);
    }
  );

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

      // The two forms denote the same instants, so they must agree — that
      // equality is the actual assertion here, not the accept itself.
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
