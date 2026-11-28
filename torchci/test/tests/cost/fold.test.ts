// Day cells folded into bars (lib/tests/cost/fold.ts), from the day-rollup
// trend.json (14 days of cells Oct 22 – Nov 4, March 1 in the daily totals
// only) and the live /series answers beside this file: every bar sums its days,
// counts days with data and pushes, says "n of N days", and the drawn
// window starts at the first bar with data.

import { addDays, type Day } from "lib/api/tests/cost/contracts";
import { CostTrendSchema } from "lib/api/tests/cost/types";
import {
  daysNote,
  foldBars,
  isPartialBar,
  rollupUnits,
  rollupWord,
  seriesDayCells,
  trendDayCells,
} from "lib/tests/cost/fold";
import { shownRange, trendContext } from "lib/tests/cost/select";
import SERIES_OWNER from "./series_owner.json";
import TREND_JSON from "./trend.json";

const answer = CostTrendSchema.parse(TREND_JSON);
const ctx = trendContext(answer);
const cells = trendDayCells(answer);

// The bar holding a day, or -1.
function barAt(fold: ReturnType<typeof foldBars>, day: Day): number {
  return fold.bars.findIndex((b) => day >= b.start && day <= b.last);
}

function rawHours(fold: ReturnType<typeof foldBars>): number[] {
  const out = fold.bars.map(() => 0);
  for (let c = 0; c < fold.cells.cellH.length; c++) {
    const b = fold.cellBar[c];
    if (b >= 0) out[b] += fold.cells.cellH[c];
  }
  return out;
}

describe("trendDayCells", () => {
  it("keeps every cell with its day", () => {
    expect(cells.days).toEqual(answer.daily.days);
    expect(cells.cellH.length).toBe(answer.cells.length);
    answer.cells.forEach(([p, , , h], c) => {
      expect(cells.days[cells.cellDay[c]]).toBe(answer.periods[p]);
      expect(cells.cellH[c]).toBe(h);
    });
  });
});

describe("foldBars", () => {
  it("folds day bars to the trend's day sums", () => {
    const shown = shownRange("day", 42, ctx.end);
    const fold = foldBars(cells, "day", shown, ctx);
    expect(fold.bars).toHaveLength(42);
    // March 1 has data, before the window: nothing cut.
    expect(fold.window?.from).toBe(shown.from);
    const sums = rawHours(fold);
    const byPeriod = answer.periods.map(() => 0);
    for (const [p, , , h] of answer.cells) byPeriod[p] += h;
    expect(sums).toEqual(byPeriod.map((v) => expect.closeTo(v, 9)));
    expect(fold.bars[41]).toMatchObject({
      start: "2026-11-04",
      data: 1,
      pushes: 8,
    });
  });

  it("folds weeks and months from the same days", () => {
    const week = foldBars(cells, "week", shownRange("week", 13, ctx.end), ctx);
    const total = rawHours(week).reduce((x, y) => x + y, 0);
    const all = answer.cells.reduce((x, c) => x + c[3], 0);
    expect(total).toBeCloseTo(all, 9);
    const oct19 = week.bars[barAt(week, "2026-10-22")];
    expect(oct19).toMatchObject({ start: "2026-10-19", data: 4, calendar: 7 });
    expect(daysNote(oct19)).toBe("4 of 7 days");
    const current = week.bars[week.bars.length - 1];
    expect(current.start).toBe("2026-11-02");
    expect(daysNote(current)).toBe("3 of 7 days so far");
    expect(current.pushes).toBe(24);
    const month = foldBars(
      cells,
      "month",
      shownRange("month", 6, ctx.end),
      ctx
    );
    const oct = month.bars[barAt(month, "2026-10-01")];
    expect(oct.data).toBe(10);
    expect(daysNote(oct)).toBe("10 of 31 days");
    expect(daysNote(month.bars[month.bars.length - 1])).toBe(
      "4 of 30 days so far"
    );
  });

  it("starts the drawn bars at the first bar with data", () => {
    const fresh = CostTrendSchema.parse({
      ...TREND_JSON,
      daily: {
        ...TREND_JSON.daily,
        days: TREND_JSON.daily.days.slice(1),
        pushes: TREND_JSON.daily.pushes.slice(1),
      },
    });
    const c = trendContext(fresh);
    expect(c.firstDay).toBe("2026-10-22");
    const day = foldBars(
      trendDayCells(fresh),
      "day",
      shownRange("day", 42, c.end),
      c
    );
    expect(day.window?.from).toBe("2026-10-22");
    expect(day.bars).toHaveLength(14);
    const week = foldBars(
      trendDayCells(fresh),
      "week",
      shownRange("week", 52, c.end),
      c
    );
    expect(week.bars.map((b) => b.start)).toEqual([
      "2026-10-19",
      "2026-10-26",
      "2026-11-02",
    ]);
  });

  it("folds a series and marks a bar holding a day still filling", () => {
    // The live answer for inductor (Oct 29 – Nov 18), its last day filling.
    const live = { ...SERIES_OWNER, filling: ["2026-11-18"] };
    const series = seriesDayCells(live as never);
    const end = addDays(live.to, 1);
    const c = {
      end,
      firstDay: live.days[0],
      lastFull: addDays(end, -2),
      days: new Set(live.days),
      filling: new Set(live.filling),
    };
    const fold = foldBars(series, "week", shownRange("week", 6, end), c);
    // The data start cuts the Show window's left.
    expect(fold.window!.from > fold.shown.from).toBe(true);
    expect(fold.bars.map((b) => [b.start, b.data, b.filling])).toEqual([
      ["2026-10-26", 4, false],
      ["2026-11-02", 7, false],
      ["2026-11-09", 7, false],
      ["2026-11-16", 3, true],
    ]);
    expect(isPartialBar(fold.bars[1])).toBe(false);
    expect(isPartialBar(fold.bars[3])).toBe(true);
    expect(daysNote(fold.bars[3])).toBe("3 of 7 days so far");
  });
});

// n days from a start, every day counted.
const run = (from: Day, n: number): Day[] =>
  Array.from({ length: n }, (_, i) => addDays(from, i));

// What Total divides a side by: the bars its counted days fall in, each
// one whole bar.
describe("rollupUnits", () => {
  it("counts a day per day in Day view: per day as before", () => {
    expect(rollupUnits("day", run("2026-11-02", 7))).toBe(7);
    expect(rollupUnits("day", [])).toBe(0);
    expect(rollupWord("day")).toBe("a day");
  });

  it("counts a whole Mon–Sun week as 1: a week is its total", () => {
    expect(rollupUnits("week", run("2026-11-02", 7))).toBe(1);
    expect(rollupWord("week")).toBe("a week");
  });

  it("counts two whole weeks as 2: their average week", () => {
    expect(rollupUnits("week", run("2026-11-02", 14))).toBe(2);
  });

  it("counts a partial week as a whole week: it reads naturally lower", () => {
    // Mon–Thu of the current week: one bar.
    expect(rollupUnits("week", run("2026-11-16", 4))).toBe(1);
    // Thu–Wed touches two weeks: two bars.
    expect(rollupUnits("week", run("2026-11-05", 7))).toBe(2);
    // A week missing its Wednesday is still one week.
    const gap = run("2026-11-02", 7).filter((d) => d !== "2026-11-04");
    expect(rollupUnits("week", gap)).toBe(1);
  });

  it("counts a whole month as 1, 31 days or 30", () => {
    expect(rollupUnits("month", run("2026-10-01", 31))).toBe(1);
    expect(rollupUnits("month", run("2026-11-01", 30))).toBe(1);
    expect(rollupUnits("month", run("2026-02-01", 28))).toBe(1);
    expect(rollupWord("month")).toBe("a month");
    // 3 of October's 31 days and 19 of November's 30: two bars.
    expect(
      rollupUnits("month", [...run("2026-10-29", 3), ...run("2026-11-01", 19)])
    ).toBe(2);
  });

  it("counts a bar with any priced day in $; a bar with none is left out", () => {
    const priced = run("2026-11-02", 7).filter(
      (d) => d !== "2026-11-07" && d !== "2026-11-08"
    );
    expect(rollupUnits("week", priced)).toBe(1);
    // No priced day in the week: nothing to count.
    expect(rollupUnits("week", [])).toBe(0);
  });
});
