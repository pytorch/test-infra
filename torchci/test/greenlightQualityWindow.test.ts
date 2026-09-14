// Pins the absent-bound behaviour of the effective-window helpers.
//
// dayjs.utc(undefined) returns the current time rather than an invalid date, so a guard
// written against the parsed result never fires for a missing field. That made
// isEmptyWindow(undefined) answer from a race between two clock reads — true whenever the
// two calls landed in the same millisecond, false when they straddled one — and made
// effectiveWindowDays(undefined) return 0 instead of undefined, leaving the unknown-span
// branch of the auto-refresh decision unreachable. Neither showed up in tsc, lint or the
// rendered page.

import {
  ABSENT,
  effectiveWindowDays,
  isEmptyWindow,
  percentUnitsFormatter,
  secondsFormatter,
  utcStamp,
} from "lib/greenlight/qualityFigures";

const ABSENT_BOUNDS = [
  undefined,
  null,
  "",
  {},
  { effective_start: "2026-08-01T00:00:00Z" },
];

describe("effective-window helpers with absent bounds", () => {
  test.each(ABSENT_BOUNDS)("effectiveWindowDays is undefined for %p", (row) => {
    expect(effectiveWindowDays(row)).toBeUndefined();
  });

  test.each(ABSENT_BOUNDS)("isEmptyWindow is false for %p", (row) => {
    expect(isEmptyWindow(row)).toBe(false);
  });

  test("isEmptyWindow does not depend on when it is called", () => {
    const answers = new Set(
      Array.from({ length: 2000 }, () => isEmptyWindow(undefined))
    );
    expect(Array.from(answers)).toEqual([false]);
  });
});

describe("effective-window helpers with real bounds", () => {
  const row = {
    effective_start: "2026-08-03T00:00:00.000Z",
    effective_end: "2026-09-02T00:00:00.000Z",
  };

  test("spans a normal window in fractional days", () => {
    expect(effectiveWindowDays(row)).toBeCloseTo(30, 6);
  });

  test("a normal window is not empty", () => {
    expect(isEmptyWindow(row)).toBe(false);
  });

  test("an end at or before the start is empty", () => {
    const inverted = {
      effective_start: "2026-07-31T19:35:59.404Z",
      effective_end: "2025-02-01T00:00:00.000Z",
    };
    expect(isEmptyWindow(inverted)).toBe(true);
    expect(
      isEmptyWindow({
        effective_start: row.effective_start,
        effective_end: row.effective_start,
      })
    ).toBe(true);
  });
});

describe("utcStamp", () => {
  test("renders a real timestamp in UTC", () => {
    expect(utcStamp("2026-08-03T04:00:00.000Z")).toBe("2026-08-03 04:00");
  });

  // Absence reaches this formatter two ways and both are ordinary, not edge cases.
  // join_use_nulls = 0 on this cluster, so a timestamp a LEFT JOIN could not resolve
  // arrives as the epoch. Separately, greenlight_quality_reverts projects
  // `if(verdict = '', NULL, verdict_at)`, which ClickHouse types Nullable(DateTime64(3))
  // and JSONEachRow serialises as literal `null` — most rows in a typical window take
  // that branch, because most reverts are of PRs GreenLight never evaluated.
  //
  // The two take different paths in here: the epoch parses fine and is caught on value,
  // while null is rejected on type before dayjs sees it. dayjs.utc(null) would otherwise
  // be an Invalid Date, which formats as the string "Invalid Date" rather than throwing.
  // The remaining shapes are what a driver or format change could plausibly substitute
  // for a null; none of them may reach a cell either.
  test.each([
    "1970-01-01T00:00:00.000Z",
    "1970-01-01 00:00:00.000",
    "",
    null,
    undefined,
    "\\N",
    "null",
    "0000-00-00 00:00:00",
    "not a date",
  ])("renders %p as a dash", (value) => {
    expect(utcStamp(value)).toBe(ABSENT);
  });

  test("the dash is one shared constant, not a literal per formatter", () => {
    expect(utcStamp(null)).toBe(ABSENT);
    expect(percentUnitsFormatter(null)).toBe(ABSENT);
    expect(secondsFormatter(null)).toBe(ABSENT);
  });
});
