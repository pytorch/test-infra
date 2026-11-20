// The Trends picker (lib/tests/cost/select.ts): the picker's steps as
// reducer checkpoints, week/month snapping, the right-edge A = B
// clamp, off-chart widening, swap, presets on the data's real dates,
// and its rules: nothing reads the clock, and an A before
// the data survives resolveCompare.

import {
  addDays,
  type Day,
  type DayRange,
  type TrendContext,
  type TrendsQuery,
} from "lib/api/tests/cost/contracts";
import {
  barCount,
  comparePresets,
  fitShow,
  ghostFor,
  lastTwoBars,
  lengthText,
  overlapDays,
  type PickAction,
  type PickEnv,
  type Picker,
  pickerOf,
  presetRanges,
  rangeText,
  reducePicker,
  resolveCompare,
  selectionPatch,
  shownRange,
  snapRange,
  trendContext,
  visibleRange,
} from "lib/tests/cost/select";

const r = (from: Day, to: Day = from): DayRange => ({ from, to });

function days(from: Day, to: Day): Day[] {
  const out: Day[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

function ctxOf(
  from: Day,
  to: Day,
  end: Day,
  filling: Day[] = []
): TrendContext {
  const all = days(from, to);
  return {
    end,
    firstDay: all[0],
    lastFull:
      filling.includes(addDays(end, -1)) || !all.includes(addDays(end, -1))
        ? addDays(end, -2)
        : addDays(end, -1),
    days: new Set(all),
    filling: new Set(filling),
  };
}

const query = (patch: Partial<TrendsQuery> = {}): TrendsQuery => ({
  rollup: "day",
  show: null,
  cmp: null,
  a: null,
  b: null,
  per: "day",
  unit: "hours",
  ...patch,
});

// The picker's fixture: 42 days of data through Nov 18, today Nov 19.
const PICK_CTX = ctxOf("2026-10-08", "2026-11-18", "2026-11-19");
const PICK_ENV: PickEnv = {
  window: shownRange("day", 42, PICK_CTX.end),
  ctx: PICK_CTX,
};

const fmt = (p: Picker) =>
  `armed ${p.armed.toUpperCase()} | A ${rangeText(p.sel.a)} | B ${rangeText(
    p.sel.b
  )}`;

describe("picker step checkpoints", () => {
  it("walks the picker's steps", () => {
    const compare = resolveCompare(query(), PICK_CTX)!;
    let p = pickerOf(compare);
    const step = (action: PickAction) =>
      (p = reducePicker(p, action, PICK_ENV));
    expect(fmt(p)).toBe("armed B | A Nov 17 | B Nov 18");
    step({ type: "place", side: p.armed, at: "2026-11-05" });
    expect(fmt(p)).toBe("armed B | A Nov 17 | B Nov 5"); // 1
    step({ type: "arm", side: "a" });
    expect(fmt(p)).toBe("armed A | A Nov 17 | B Nov 5"); // 2
    step({ type: "place", side: p.armed, at: "2026-11-04" });
    expect(fmt(p)).toBe("armed A | A Nov 4 | B Nov 5"); // 3
    step({ type: "stretch", side: "b", edge: "to", at: "2026-11-11" });
    expect(fmt(p)).toBe("armed A | A Nov 4 | B Nov 5 – 11"); // 4
    step({ type: "slide", side: "b", by: 1 });
    expect(fmt(p)).toBe("armed A | A Nov 4 | B Nov 6 – 12"); // 5
    step({ type: "arm", side: "b" });
    expect(fmt(p)).toBe("armed B | A Nov 4 | B Nov 6 – 12"); // 6
    step({ type: "draw", side: p.armed, from: "2026-10-20", to: "2026-10-26" });
    expect(fmt(p)).toBe("armed B | A Nov 4 | B Oct 20 – 26"); // 7
    step({ type: "draw", side: p.armed, from: "2026-11-06", to: "2026-11-12" });
    expect(fmt(p)).toBe("armed B | A Nov 4 | B Nov 6 – 12"); // 8
    step({ type: "move", by: -1 });
    expect(fmt(p)).toBe("armed B | A Nov 4 | B Nov 5 – 11"); // 9
    step({ type: "resize", by: 1 });
    expect(fmt(p)).toBe("armed B | A Nov 4 | B Nov 5 – 12"); // 10
    // 11: a drag computes each frame from its origin; Esc keeps the origin.
    const origin = p;
    const live = reducePicker(
      origin,
      { type: "stretch", side: "a", edge: "from", at: "2026-10-29" },
      PICK_ENV
    );
    expect(rangeText(live.sel.a, false)).toBe("Oct 29 – Nov 4"); // 11a
    expect(fmt(origin)).toBe("armed B | A Nov 4 | B Nov 5 – 12"); // 11b
    // 12: a jittery click (under DRAG_PX) is a click: B keeps its 8 days.
    step({ type: "place", side: p.armed, at: "2026-10-10" });
    expect(fmt(p)).toBe("armed B | A Nov 4 | B Oct 10 – 17"); // 12
    // 13: the ghost follows the armed side.
    step({ type: "arm", side: "b" });
    expect(ghostFor(p, p.armed, "2026-10-20", PICK_ENV)).toEqual(
      r("2026-10-20", "2026-10-27")
    );
    step({ type: "arm", side: "a" });
    expect(ghostFor(p, p.armed, "2026-10-20", PICK_ENV)).toEqual(
      r("2026-10-20")
    );
    expect(ghostFor(p, p.armed, "2026-11-04", PICK_ENV)).toBeNull(); // where A sits
  });

  it("clamps placement to the window and keeps the length", () => {
    let p = pickerOf(resolveCompare(query({ cmp: "7v7" }), PICK_CTX)!);
    expect(fmt(p)).toBe("armed B | A Nov 5 – 11 | B Nov 12 – 18");
    p = reducePicker(
      p,
      { type: "place", side: "b", at: "2026-11-16" },
      PICK_ENV
    );
    expect(rangeText(p.sel.b)).toBe("Nov 12 – 18"); // unchanged: already there
    p = reducePicker(
      p,
      { type: "place", side: "b", at: "2026-10-01" },
      PICK_ENV
    );
    expect(rangeText(p.sel.b)).toBe("Oct 8 – 14"); // the window's first bar
    p = reducePicker(p, { type: "move", by: 1, whole: true }, PICK_ENV);
    expect(rangeText(p.sel.b)).toBe("Oct 15 – 21"); // Shift+→: its own length
  });

  it("places A on B at the right edge (the A = B case)", () => {
    let p = pickerOf(resolveCompare(query(), PICK_CTX)!, "a");
    p = reducePicker(
      p,
      { type: "place", side: "a", at: "2026-11-18" },
      PICK_ENV
    );
    expect(p.sel.a).toEqual(p.sel.b);
    expect(overlapDays(p.sel.a, p.sel.b)).toBe(1);
  });

  it("grows at the start once ] reaches the right edge; [ stops at 1 bar", () => {
    let p = pickerOf(resolveCompare(query(), PICK_CTX)!);
    p = reducePicker(p, { type: "resize", by: 1 }, PICK_ENV);
    expect(rangeText(p.sel.b)).toBe("Nov 17 – 18");
    p = reducePicker(p, { type: "resize", by: -1 }, PICK_ENV);
    p = reducePicker(p, { type: "resize", by: -1 }, PICK_ENV);
    expect(rangeText(p.sel.b)).toBe("Nov 17");
  });

  it("swaps without a preset", () => {
    let p = pickerOf(resolveCompare(query(), PICK_CTX)!);
    for (let i = 0; i < 25; i++) {
      p = reducePicker(p, { type: "move", by: -1 }, PICK_ENV);
    }
    const before = p.sel;
    p = reducePicker(p, { type: "swap" }, PICK_ENV);
    expect(p.sel.a).toEqual(before.b);
    expect(p.sel.b).toEqual(before.a);
    expect(p.sel.preset).toBeNull();
  });
});

describe("snapping", () => {
  const ctx = ctxOf("2025-11-01", "2026-11-18", "2026-11-19");
  it("draws whole weeks: Sep 1 → 20 gives Aug 31 – Sep 20", () => {
    const env = { window: shownRange("week", 52, ctx.end), ctx };
    let p = pickerOf(resolveCompare(query({ rollup: "week" }), ctx)!);
    expect(rangeText(p.sel.b)).toBe("Nov 9 – 15");
    p = reducePicker(
      p,
      { type: "draw", side: "b", from: "2026-09-01", to: "2026-09-20" },
      env
    );
    expect(p.sel.b).toEqual(r("2026-08-31", "2026-09-20"));
    expect(lengthText("week", p.sel.b)).toBe("3 weeks");
  });

  it("draws whole months, the current one clipped at yesterday", () => {
    const env = { window: shownRange("month", 12, ctx.end), ctx };
    let p = pickerOf(resolveCompare(query({ rollup: "month" }), ctx)!);
    expect(p.sel.b).toEqual(r("2026-10-01", "2026-10-31"));
    p = reducePicker(
      p,
      { type: "draw", side: "b", from: "2026-11-03", to: "2026-10-15" },
      env
    );
    expect(p.sel.b).toEqual(r("2026-10-01", "2026-11-18"));
    expect(barCount("month", p.sel.b)).toBe(2);
  });

  it("snaps a URL range outward to whole bars", () => {
    const c = resolveCompare(
      query({
        rollup: "week",
        a: r("2026-11-04", "2026-11-05"),
        b: r("2026-11-12"),
      }),
      ctx
    )!;
    expect(c.a).toEqual(r("2026-11-02", "2026-11-08"));
    expect(c.b).toEqual(r("2026-11-09", "2026-11-15"));
    expect(c.preset).toBe("wow");
  });
});

describe("off-chart periods", () => {
  it("widens Show to the smallest option holding the period", () => {
    expect(fitShow("day", r("2026-10-02", "2026-10-03"), PICK_CTX.end)).toBe(
      90
    );
    expect(fitShow("day", r("2026-11-10"), PICK_CTX.end)).toBe(14);
    expect(fitShow("day", r("2025-01-01"), PICK_CTX.end)).toBeNull();
  });
});

// The data as it was on 11-19 (end 11-20 UTC): Oct 29 – Nov 19, Nov 19
// still filling.
const LIVE = ctxOf("2026-10-29", "2026-11-19", "2026-11-20", ["2026-11-19"]);

describe("presets on the data's dates", () => {
  it("enables DoD, WoW and 7v7 and disables MoM and 28v28", () => {
    const presets = comparePresets(LIVE);
    const by = Object.fromEntries(presets.map((p) => [p.id, p]));
    expect(LIVE.lastFull).toBe("2026-11-18");
    expect([by.dod.a, by.dod.b].map((x) => rangeText(x))).toEqual([
      "Nov 17",
      "Nov 18",
    ]);
    expect([by.wow.a, by.wow.b].map((x) => rangeText(x))).toEqual([
      "Nov 2 – 8",
      "Nov 9 – 15",
    ]);
    expect([by["7v7"].a, by["7v7"].b].map((x) => rangeText(x))).toEqual([
      "Nov 5 – 11",
      "Nov 12 – 18",
    ]);
    expect(presets.filter((p) => p.available).map((p) => p.id)).toEqual([
      "dod",
      "wow",
      "7v7",
    ]);
    expect(by.mom.title).toBe("Needs Sep 1 – Oct 31; data starts Oct 29");
    expect(by["28v28"].title).toBe("Needs Sep 24 – Nov 18; data starts Oct 29");
  });

  it("falls back to the last two bars with data for Month", () => {
    const c = resolveCompare(query({ rollup: "month" }), LIVE)!;
    expect(c.a).toEqual(r("2026-10-01", "2026-10-31"));
    expect(c.b).toEqual(r("2026-11-01", "2026-11-19"));
    expect(lastTwoBars("day", LIVE)).toEqual({
      a: r("2026-11-17"),
      b: r("2026-11-18"),
    }); // Nov 19 alone is still filling
  });

  it("switches rollup: DoD → Week applies WoW; WoW → Day keeps the weeks", () => {
    const env = { window: shownRange("day", 42, LIVE.end), ctx: LIVE };
    let p = pickerOf(resolveCompare(query(), LIVE)!);
    p = reducePicker(p, { type: "rollup", rollup: "week" }, env);
    expect(p.sel).toEqual({
      rollup: "week",
      a: r("2026-11-02", "2026-11-08"),
      b: r("2026-11-09", "2026-11-15"),
      preset: "wow",
    });
    expect(selectionPatch(p.sel, LIVE)).toEqual({
      rollup: "week",
      cmp: "wow",
      a: null,
      b: null,
    });
    p = reducePicker(p, { type: "rollup", rollup: "day" }, env);
    expect(p.sel.rollup).toBe("day");
    expect(p.sel.b).toEqual(r("2026-11-09", "2026-11-15"));
  });

  it("applies a preset with its rollup and writes only cmp", () => {
    const env = { window: shownRange("day", 42, LIVE.end), ctx: LIVE };
    let p = pickerOf(resolveCompare(query(), LIVE)!);
    p = reducePicker(p, { type: "preset", id: "7v7" }, env);
    expect(selectionPatch(p.sel, LIVE)).toEqual({
      rollup: "day",
      cmp: "7v7",
      a: null,
      b: null,
    });
    p = reducePicker(p, { type: "move", by: -1 }, env);
    expect(selectionPatch(p.sel, LIVE)).toEqual({
      rollup: "day",
      cmp: null,
      a: r("2026-11-05", "2026-11-11"),
      b: r("2026-11-11", "2026-11-17"),
    });
  });
});

describe("resolveCompare", () => {
  it("keeps an A wholly before the data (round trip unchanged)", () => {
    const q = query({
      a: r("2026-10-20", "2026-10-26"),
      b: r("2026-11-12", "2026-11-18"),
    });
    const c = resolveCompare(q, LIVE)!;
    expect(c.a).toEqual(q.a);
    expect(c.b).toEqual(q.b);
    const patch = selectionPatch(
      { rollup: c.rollup, a: c.a, b: c.b, preset: c.preset },
      LIVE
    );
    expect(patch).toEqual({ rollup: "day", cmp: null, a: q.a, b: q.b });
  });

  it("lets a/b win over cmp and falls back on malformed ranges", () => {
    const c = resolveCompare(
      query({ cmp: "7v7", a: r("2026-11-01"), b: r("2026-11-02") }),
      LIVE
    )!;
    expect([c.a, c.b]).toEqual([r("2026-11-01"), r("2026-11-02")]);
    const bad = resolveCompare(
      query({ a: r("2026-13-40"), b: r("nope") }),
      LIVE
    )!;
    expect([bad.a, bad.b]).toEqual([r("2026-11-17"), r("2026-11-18")]);
    // A range after the data's last day is dropped; one ending past it clips.
    const clipped = resolveCompare(
      query({ a: r("2026-11-15", "2026-11-25"), b: r("2026-11-21") }),
      LIVE
    )!;
    expect(clipped.a).toEqual(r("2026-11-15", "2026-11-19"));
    expect(clipped.b).toEqual(r("2026-11-18"));
  });

  it("gives a lone a or b its neighbour of the same length", () => {
    // A link with only b: A is the period just before it, never B itself.
    const week = resolveCompare(
      query({ rollup: "week", b: r("2026-11-02", "2026-11-08") }),
      LIVE
    )!;
    expect([week.a, week.b]).toEqual([
      r("2026-10-26", "2026-11-01"),
      r("2026-11-02", "2026-11-08"),
    ]);
    const days7 = resolveCompare(
      query({ b: r("2026-11-12", "2026-11-18") }),
      LIVE
    )!;
    expect(days7.a).toEqual(r("2026-11-05", "2026-11-11"));
    const lone = resolveCompare(
      query({ a: r("2026-11-01", "2026-11-03") }),
      LIVE
    )!;
    expect(lone.b).toEqual(r("2026-11-04", "2026-11-06"));
    // cmp still names the other side when given.
    const cmp = resolveCompare(
      query({ cmp: "dod", b: r("2026-11-12", "2026-11-18") }),
      LIVE
    )!;
    expect(cmp.a).toEqual(r("2026-11-17"));
  });
});

describe("no clock", () => {
  afterEach(() => jest.useRealTimers());
  it("reads only the answer's end: a clock a day ahead changes nothing", () => {
    const run = () => ({
      shown: shownRange("day", 42, LIVE.end),
      week: shownRange("week", 52, LIVE.end),
      presets: comparePresets(LIVE).map((p) => [p.id, p.a, p.b, p.available]),
      compare: resolveCompare(query({ rollup: "month" }), LIVE),
      visible: visibleRange("day", shownRange("day", 42, LIVE.end), LIVE),
      dod: presetRanges("dod", LIVE),
    });
    jest.useFakeTimers().setSystemTime(new Date("2026-11-20T12:00:00Z"));
    const today = run();
    jest.setSystemTime(new Date("2026-11-21T12:00:00Z"));
    expect(run()).toEqual(today);
    expect(today.shown).toEqual(r("2026-10-09", "2026-11-19"));
    expect(today.visible).toEqual(r("2026-10-29", "2026-11-19"));
  });
});

describe("trendContext", () => {
  it("reads end, the first day, L and the filling days from the answer", () => {
    const ctx = trendContext({
      repo: "pytorch/pytorch",
      rollup: "day",
      workflows: [],
      start: "2026-10-09",
      end: "2026-11-20",
      periods: [],
      owners: [],
      labels: [],
      cells: [],
      daily: {
        start: "2026-01-01",
        days: days("2026-10-29", "2026-11-19"),
        filling: ["2026-11-19"],
        pushes: [],
        cells: [],
      },
      query_duration_ms: 0,
    });
    expect(ctx.firstDay).toBe("2026-10-29");
    expect(ctx.lastFull).toBe("2026-11-18");
    expect(ctx.days.size).toBe(22);
    expect(snapRange("week", r("2026-11-19"), addDays(ctx.end, -1))).toEqual(
      r("2026-11-16", "2026-11-19")
    );
  });
});
