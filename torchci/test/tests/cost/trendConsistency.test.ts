// The example trend answer beside this file, trend.json (an answer of GET
// /api/tests/cost/trend by day), checked against itself and the schema: A's
// and B's runner-hours, push:main runner-hours and pushes, each day's totals
// as its cells summed over the owners, and no negative hour.

import { CostTrendSchema } from "lib/api/tests/cost/types";
import TREND_JSON from "./trend.json";

const answer = CostTrendSchema.parse(TREND_JSON);

const sum = (xs: Iterable<number>) => Array.from(xs).reduce((a, b) => a + b, 0);
const inRange = (day: string, from: string, to: string) =>
  day >= from && day <= to;
// Oct 22 – Oct 28 and Oct 29 – Nov 4.
const A_DAYS = ["2026-10-22", "2026-10-28"] as const;
const B_DAYS = ["2026-10-29", "2026-11-04"] as const;

// trend.json's cells on some days, from the JSON alone: [owner, label,
// runner-hours, push:main runner-hours].
function cellsOn(
  days: readonly [string, string]
): [string, string, number, number][] {
  return answer.cells
    .filter(([p]) => inRange(answer.periods[p], ...days))
    .map(([, o, l, h, main]) => [answer.owners[o], answer.labels[l], h, main]);
}

describe("the example answers", () => {
  test("trend.json holds 259 runner-hours over A's 7 days and 266 over B's, 68.25 and 75.25 of them of pushes to main, over 70 and 56 pushes", () => {
    for (const [days, hours, main, pushes] of [
      [A_DAYS, 259, 68.25, 70],
      [B_DAYS, 266, 75.25, 56],
    ] as const) {
      const cells = cellsOn(days);
      expect(sum(cells.map((c) => c[2]))).toBe(hours);
      expect(sum(cells.map((c) => c[3]))).toBe(main);
      const daily = answer.daily.days.flatMap((day, d) =>
        inRange(day, days[0], days[1]) ? [answer.daily.pushes[d]] : []
      );
      expect(daily).toHaveLength(7);
      expect(sum(daily)).toBe(pushes);
    }
  });

  test("each day's totals are its cells summed over the owners", () => {
    for (const [d, day] of answer.daily.days.entries()) {
      const p = answer.periods.indexOf(day);
      if (p < 0) continue;
      const byLabel = (rows: [number, number, number][]) => {
        const m = new Map<number, [number, number]>();
        for (const [l, h, main] of rows) {
          const t = m.get(l) ?? [0, 0];
          m.set(l, [t[0] + h, t[1] + main]);
        }
        return m;
      };
      expect(
        byLabel(
          answer.daily.cells
            .filter((c) => c[0] === d)
            .map(([, l, h, main]) => [l, h, main])
        )
      ).toEqual(
        byLabel(
          answer.cells
            .filter((c) => c[0] === p)
            .map(([, , l, h, main]) => [l, h, main])
        )
      );
    }
  });

  test("no hour is negative, and every cell's push:main hours are part of its runner-hours", () => {
    const tuples = [
      ...answer.cells.map(([, , , h, main]) => [h, main]),
      ...answer.daily.cells.map(([, , h, main]) => [h, main]),
    ];
    for (const [h, main] of tuples) {
      expect(main).toBeGreaterThanOrEqual(0);
      expect(main).toBeLessThanOrEqual(h);
    }
  });

  test("the schemas refuse a negative runner-hour", () => {
    const negative = (cells: unknown) => ({ ...TREND_JSON, cells });
    expect(
      CostTrendSchema.safeParse(negative([[0, 0, 0, -1, 0]])).success
    ).toBe(false);
    expect(
      CostTrendSchema.safeParse(negative([[0, 0, 0, 1, -0.5]])).success
    ).toBe(false);
    expect(
      CostTrendSchema.safeParse({
        ...TREND_JSON,
        daily: { ...TREND_JSON.daily, cells: [[0, 0, -2, 0]] },
      }).success
    ).toBe(false);
  });
});
