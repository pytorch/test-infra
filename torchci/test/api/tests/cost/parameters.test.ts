import { MAX_CHANGE_DAYS, parseDayRange } from "lib/api/tests/cost/parameters";

describe("the periods compared", () => {
  test("from..to, both real days in order, at most 400 days", () => {
    expect(parseDayRange("2026-10-22..2026-10-28")).toEqual({
      from: "2026-10-22",
      to: "2026-10-28",
    });
    expect(parseDayRange("2026-11-04..2026-11-04")).toEqual({
      from: "2026-11-04",
      to: "2026-11-04",
    });
    // A leap day, and 400 days to the day.
    expect(parseDayRange("2028-02-29..2028-02-29")).not.toBeNull();
    expect(parseDayRange("2026-01-01..2027-02-04")).not.toBeNull();
    expect(MAX_CHANGE_DAYS).toBe(400);
    for (const bad of [
      "2026-01-01..2027-02-05",
      "2026-10-28..2026-10-22",
      "2026-02-30..2026-03-01",
      "2026-10-22",
      "2026-10-22...2026-10-28",
      "2026-10-22..2026-10-28 ",
      "22-10-2026..28-10-2026",
    ]) {
      expect(parseDayRange(bad)).toBeNull();
    }
  });
});
