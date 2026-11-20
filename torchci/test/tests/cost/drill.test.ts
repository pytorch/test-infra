// The drill-down's pure model (lib/tests/cost/drill.ts) over /scope and
// /cases answers captured from a local dev server on 2026-11-19 (A = Nov
// 5–11, B = Nov 12–18): trail edits and validity, rows, cuts, scales, the
// change sentence, per commit and $ with a stub Pricer, the test level, and
// what a row opened in place lists.

import type {
  CostCases,
  CostScope,
  Day,
  PieceRate,
  Pill,
  Pricer,
  RateDayKind,
} from "lib/api/tests/cost/contracts";
import {
  addDays,
  childBy,
  NO_TEST_REPORTS,
  UNKNOWN_MACHINE,
} from "lib/api/tests/cost/contracts";
import type { CostTrend } from "lib/api/tests/cost/types";
import {
  appendPill,
  canFlip,
  CASE_VIEW_ORDER,
  casesSummary,
  casesView,
  CHANGE_MIN_SIDE,
  changeScale,
  changeSentence,
  changeText,
  chooseRoot,
  climbTo,
  cutRows,
  dropPill,
  expansionOf,
  expansionRows,
  FACTS_DAYS,
  filterCases,
  flipPills,
  halfScale,
  labelRows,
  laneGroups,
  laneRows,
  levelView,
  machineFacets,
  machineSwitches,
  NESTED_TOP,
  nextDim,
  ownedShareOfTrend,
  pageFacts,
  PCT_CAP,
  type Phrase,
  recentDays,
  rowByKey,
  scopeName,
  scopeTitle,
  segments,
  sideChips,
  sortRows,
  structuralTrail,
  sumRows,
  swapPill,
  testsListHref,
  trendDaily,
  validTrail,
  windowText,
} from "lib/tests/cost/drill";
import CASES_OK from "./cases_ok.json";
import FILE from "./scope_file.json";
import OWNER from "./scope_owner.json";
import PAIR from "./scope_pair.json";
import PAIR_LABEL from "./scope_pair_label.json";
import ROOT from "./scope_root.json";

const root = ROOT as unknown as CostScope;
const owner = OWNER as unknown as CostScope;
const pair = PAIR as unknown as CostScope;
const file = FILE as unknown as CostScope;
const pairLabel = PAIR_LABEL as unknown as CostScope; // inductor on avx512, by=label
const casesOk = CASES_OK as unknown as CostCases;

const IND: Pill = { dim: "o", value: "inductor" };
const AVX: Pill = { dim: "m", value: "Linux x86_64 avx512" };
const FLEX: Pill = { dim: "f", value: "test/inductor/test_flex_attention.py" };
const hours = { unit: "hours" as const, per: "day" as const, pricer: null };
const text = (p: Phrase[] | null) => (p ?? []).map((x) => x.text).join("");
const near = (a: number | null, b: number, digits = 6) =>
  expect(a).toBeCloseTo(b, digits);

describe("trail", () => {
  test("the next level follows the drill order", () => {
    expect(childBy([], "o")).toBe("o");
    expect(childBy([], "m")).toBe("m");
    expect(childBy([IND], "o")).toBe("m");
    expect(childBy([AVX], "o")).toBe("o");
    expect(childBy([IND, AVX], "o")).toBe("f");
    expect(childBy([AVX, IND], "o")).toBe("f");
    expect(childBy([IND, AVX, FLEX], "o")).toBe("lane");
    expect(childBy([IND, FLEX], "o")).toBe("m");
    expect(childBy([{ dim: "o", value: NO_TEST_REPORTS }, AVX], "o")).toBe(
      "label"
    );
    expect(nextDim([IND, AVX], "o")).toBe("f");
    expect(nextDim([IND, AVX, FLEX], "o")).toBeNull();
  });

  test("✕ drops one pill and keeps the rest; a file needs an owner or machine first", () => {
    expect(dropPill([IND, AVX], 0)).toEqual([AVX]);
    expect(dropPill([IND, AVX, FLEX], 1)).toEqual([IND, FLEX]);
    expect(dropPill([AVX, FLEX], 0)).toEqual([]);
    expect(structuralTrail([FLEX, IND])).toEqual([]);
  });

  test("⇄ flips an adjacent owner and machine only", () => {
    expect(canFlip([IND, AVX], 0)).toBe(true);
    expect(flipPills([IND, AVX, FLEX], 0)).toEqual([AVX, IND, FLEX]);
    expect(canFlip([IND, AVX, FLEX], 1)).toBe(false);
    expect(flipPills([IND, AVX, FLEX], 1)).toEqual([IND, AVX, FLEX]);
  });

  test("swap keeps deeper pills, climb truncates, append replaces its dimension", () => {
    expect(swapPill([IND, AVX, FLEX], 0, "core_tests")).toEqual([
      { dim: "o", value: "core_tests" },
      AVX,
      FLEX,
    ]);
    expect(climbTo([IND, AVX, FLEX], 0)).toEqual([IND]);
    expect(climbTo([IND, AVX], -1)).toEqual([]);
    expect(appendPill([IND], AVX)).toEqual([IND, AVX]);
  });

  test("the root ▾ reorders a pinned pair or starts over", () => {
    expect(chooseRoot([IND, AVX, FLEX], "m")).toEqual({
      trail: [AVX, IND, FLEX],
      root: "m",
    });
    expect(chooseRoot([IND], "m")).toEqual({ trail: [], root: "m" });
    expect(chooseRoot([], "m")).toEqual({ trail: [], root: "m" });
  });

  test("names and titles", () => {
    expect(scopeName([IND, AVX], "o")).toBe("inductor on Linux x86_64 avx512");
    expect(scopeName([IND, AVX, FLEX], "o")).toBe(
      "test_flex_attention.py of inductor on Linux x86_64 avx512"
    );
    expect(scopeTitle([IND, AVX], "o")).toEqual({
      title: "Linux x86_64 avx512",
      context: "in inductor",
    });
    expect(scopeTitle([], "m").title).toBe("All machines");
  });
});

describe("validTrail", () => {
  const empty = (s: CostScope, side: 0 | 1): CostScope => ({
    ...s,
    sides: s.sides.map((x, i) =>
      i === side ? { days: [], pushes: [], filling: [] } : x
    ) as CostScope["sides"],
  });

  test("a live trail is no change", () => {
    expect(validTrail([IND, AVX, FLEX], [root, owner, pair])).toBeNull();
  });

  test("a pill with no hours on either side is dropped with every pill after it", () => {
    const ghost: Pill = { dim: "m", value: "No such machine" };
    expect(validTrail([IND, ghost, FLEX], [root, owner, undefined])).toEqual([
      IND,
    ]);
  });

  test("a loading level or a stale echo keeps the trail", () => {
    const ghost: Pill = { dim: "m", value: "No such machine" };
    expect(validTrail([IND, ghost], [root, undefined])).toBeNull();
    expect(validTrail([IND, ghost], [undefined, owner])).toBeNull();
  });

  test("a side with no days keeps the trail", () => {
    const ghost: Pill = { dim: "m", value: "No such machine" };
    expect(validTrail([IND, ghost], [root, empty(owner, 0)])).toBeNull();
  });

  test("an owner absent from the 7-day answer but present in A keeps the trail", () => {
    // Only A has hours: B = 0 for this owner.
    const onlyA: CostScope = {
      ...root,
      children: [...root.children, "retired_owner"],
      info: [...root.info, {}],
      cells: [...root.cells, [0, 0, root.children.length, 0, 7, 1]],
    };
    expect(
      validTrail([{ dim: "o", value: "retired_owner" }], [onlyA])
    ).toBeNull();
  });

  test("a file first is dropped without any answer", () => {
    expect(validTrail([FLEX], [undefined])).toEqual([]);
  });
});

describe("rows", () => {
  const rootView = levelView(root, hours);
  const ownerView = levelView(owner, hours);
  const pairView = levelView(pair, hours);

  test("the root totals match the live page: 50.7K → 43.9K h a day", () => {
    near(rootView.total.a, 50_700, -3);
    near(rootView.total.b, 43_900, -3);
    const ind = rowByKey(rootView, "inductor");
    near(ind?.a ?? null, 14_400, -3);
    near(ind?.b ?? null, 11_800, -3);
  });

  test("a level's children sum to its parent's row", () => {
    const ind = rowByKey(rootView, "inductor");
    near(ownerView.total.a, ind?.a ?? 0, 3);
    near(ownerView.total.b, ind?.b ?? 0, 3);
    const avx = rowByKey(ownerView, AVX.value);
    near(pairView.total.a, avx?.a ?? 0, 3);
    near(pairView.total.b, avx?.b ?? 0, 3);
    near(avx?.a ?? null, 7_200, -3);
    near(avx?.b ?? null, 4_800, -3);
  });

  test("sorting puts buckets last; the cut keeps the selected row and counts the rest", () => {
    const sorted = sortRows(rootView.rows, "change", "h", true);
    const firstBucket = sorted.findIndex((r) => r.bucket);
    expect(sorted.slice(firstBucket).every((r) => r.bucket)).toBe(true);
    expect(sorted[0].key).toBe("inductor");
    const deep = sorted.filter((r) => !r.bucket && !r.hidden)[30];
    const cut = cutRows(sorted, { top: 12, expanded: false, keep: deep.key });
    expect(cut.shown.map((r) => r.key)).toContain(deep.key);
    expect(cut.more.map((r) => r.key)).not.toContain(deep.key);
    expect(cut.shown.filter((r) => !r.bucket)).toHaveLength(13);
    const all = cutRows(sorted, { top: 12, expanded: true });
    expect(all.more).toHaveLength(0);
  });

  test("grew sorts by signed change and largest B by B", () => {
    const grew = sortRows(ownerView.rows, "grew", "h", true).filter(
      (r) => !r.bucket
    );
    expect((grew[0].delta ?? 0) > 0).toBe(true);
    const big = sortRows(ownerView.rows, "b", "h", true).filter(
      (r) => !r.bucket
    );
    expect(big[0].key).toBe(AVX.value);
  });

  test("a fold line sums the unpicked rows", () => {
    const others = ownerView.rows
      .filter((r) => r.key !== AVX.value)
      .map((r) => r.key);
    const fold = sumRows(ownerView, others);
    const avx = rowByKey(ownerView, AVX.value);
    near((fold.b ?? 0) + (avx?.b ?? 0), ownerView.total.b ?? 0, 6);
  });

  test("lanes group by environment and keep the file's total", () => {
    const fileView = levelView(file, hours);
    const { common, groups } = laneGroups(fileView);
    expect(common).toEqual(
      expect.arrayContaining(["CPU", "Linux 22.04", "x86_64 avx512"])
    );
    const sumB = groups.reduce((t, g) => t + (g.row.b ?? 0), 0);
    near(sumB, fileView.total.b ?? 0, 0);
    expect(groups.every((g) => g.name !== "")).toBe(true);
  });

  test("per commit divides push:main hours by pushes; no main hours reads not on main", () => {
    const perCommit = levelView(root, { ...hours, per: "commit" });
    const mainA = root.cells
      .filter(([s]) => s === 0)
      .reduce((t, c) => t + c[5], 0);
    near(
      perCommit.total.a,
      mainA / root.sides[0].pushes.reduce((t, p) => t + p, 0)
    );
    const offMain: CostScope = {
      ...owner,
      cells: owner.cells.map((c) => [c[0], c[1], c[2], c[3], c[4], 0]),
    };
    const v = levelView(offMain, { ...hours, per: "commit" });
    expect(v.rows[0].notOnMain).toBe(true);
    near(v.rows[0].a, 0);
  });

  test("a side with no days reads no data, never 0 or new", () => {
    const noA: CostScope = {
      ...owner,
      sides: [{ days: [], pushes: [], filling: [] }, owner.sides[1]],
      cells: owner.cells.filter(([s]) => s === 1),
    };
    const v = levelView(noA, hours);
    expect(v.rows[0].a).toBeNull();
    expect(changeText(v.rows[0])).toBe("");
    expect(v.aHasDays).toBe(false);
    const sorted = sortRows(v.rows, "change", "h", v.aHasDays);
    expect(sorted[0].key).toBe(AVX.value); // falls back to largest B
    expect(sideChips(v, "2026-10-29")).toContain(
      "A has no data (test_cost starts Oct 29)"
    );
  });
});

describe("scales and text", () => {
  test("the butterfly scale is nice and covers the largest A or B", () => {
    const v = levelView(owner, hours);
    const s = halfScale(v.rows);
    expect(s.top).toBeGreaterThanOrEqual(
      Math.max(...v.rows.map((r) => Math.max(r.a ?? 0, r.b ?? 0)))
    );
    expect(s.ticks[0]).toBe(0);
  });

  test("B's side: kept, lost hatched, gained; same within 0.2% reads B only", () => {
    expect(segments(10, 6, 20)).toEqual({
      a: 0.5,
      kept: 0.3,
      lost: 0.2,
      gained: 0,
      end: 0.5,
    });
    const g = segments(6, 10, 20);
    expect(g.kept).toBeCloseTo(0.3);
    expect(g.gained).toBeCloseTo(0.2);
    expect(segments(10, 10.02, 20)).toMatchObject({ lost: 0, gained: 0 });
  });

  test("the change column keeps at least 16% for the smaller side", () => {
    const s = changeScale([-2400, -500, 3]);
    expect(s.zero).toBeLessThanOrEqual(1 - CHANGE_MIN_SIDE + 1e-9);
    expect(s.zero).toBeGreaterThan(0.5);
    expect(s.ticks).toContain(0);
    const up = changeScale([100, 2]);
    expect(up.zero).toBeCloseTo(CHANGE_MIN_SIDE);
    const both = changeScale([-50, 40]);
    expect(both.zero).toBeGreaterThan(CHANGE_MIN_SIDE);
    expect(both.zero).toBeLessThan(1 - CHANGE_MIN_SIDE);
  });

  test("% text: new, gone, ±0%, ×, and the cap only for bars", () => {
    expect(changeText({ a: 0, b: 5 })).toBe("new");
    expect(changeText({ a: 5, b: 0 })).toBe("gone");
    expect(changeText({ a: 100, b: 100.4 })).toBe("±0%");
    expect(changeText({ a: 1, b: 12 })).toBe("▲ 12×");
    expect(changeText({ a: 1, b: 3.12 })).toBe("▲ +212%");
    expect(changeText({ a: 100, b: 67 })).toBe("▼ −33%");
    expect(PCT_CAP).toBe(2);
  });

  test("machine facets for the tests list", () => {
    expect(
      machineFacets("Linux x86_64 avx512", {
        family: "Linux CPU",
        cpu: "x86_64 avx512",
      })
    ).toEqual({
      os: "linux",
      cpu_architecture: "x86_64",
      cpu_capability: "avx512",
    });
    expect(
      machineFacets("NVIDIA L4", { device: "NVIDIA L4", cpu: "x86_64 avx2" })
    ).toEqual({ device_name: "NVIDIA L4" });
    const href = testsListHref("pytorch/pytorch", [IND, AVX, FLEX], {
      family: "Linux CPU",
      cpu: "x86_64 avx512",
    });
    const q = new URL(href, "http://x").searchParams;
    expect(new URL(href, "http://x").pathname).toBe("/tests/pytorch/pytorch");
    expect(q.get("owner")).toBe("inductor");
    expect(q.get("file")).toBe(FLEX.value);
    expect(q.get("cpu_capability")).toBe("avx512");
    expect(q.get("window")).toBe("14d");
  });
});

describe("sentence", () => {
  const ownerView = levelView(owner, hours);
  const pairView = levelView(pair, hours);
  const scopeRow = rowByKey(ownerView, AVX.value)!;

  test("the live inductor × avx512 sentence", () => {
    const s = changeSentence({
      name: "inductor on Linux x86_64 avx512",
      scope: scopeRow,
      children: pairView.rows.filter((r) => !r.hidden),
      unit: "hours",
      per: "day",
      aHasDays: true,
    });
    expect(text(s)).toBe(
      "inductor on Linux x86_64 avx512 fell 2.4K h a day (−33%) from A to B. " +
        "test_cpu_select_algorithm.py explains 1.2K h of it (50%). " +
        "103 grew, led by test_precompile.py (▲ +71 h)."
    );
  });

  const row = (key: string, a: number, b: number) => ({
    ...scopeRow,
    key,
    name: key,
    a,
    b,
    delta: b - a,
    pct: a ? (b - a) / a : null,
  });

  test("only one grew, nothing grew, held steady, rose, per commit, no A", () => {
    const base = {
      name: "X",
      unit: "hours" as const,
      per: "day" as const,
      aHasDays: true,
    };
    expect(
      text(
        changeSentence({
          ...base,
          scope: row("X", 100, 50),
          children: [row("a", 80, 30), row("b", 20, 20.5)],
        })
      )
    ).toContain("Only b grew (▲ +0.5 h).");
    expect(
      text(
        changeSentence({
          ...base,
          scope: row("X", 100, 50),
          children: [row("a", 100, 50)],
        })
      )
    ).toContain("Nothing here grew.");
    expect(
      text(
        changeSentence({ ...base, scope: row("X", 100, 100.2), children: [] })
      )
    ).toBe("X held steady at 100 h a day from A to B.");
    expect(
      text(
        changeSentence({
          ...base,
          scope: row("X", 50, 100),
          children: [row("a", 10, 60), row("b", 40, 40)],
        })
      )
    ).toBe(
      "X rose 50 h a day (+100%) from A to B. a explains 50 h of it (100%). Nothing here shrank."
    );
    expect(
      text(
        changeSentence({
          ...base,
          per: "commit",
          scope: row("X", 2, 1),
          children: [],
        })
      )
    ).toBe("X fell 1 h per commit (−50%) from A to B.");
    expect(
      changeSentence({
        ...base,
        aHasDays: false,
        scope: row("X", 2, 1),
        children: [],
      })
    ).toBeNull();
    // A lead whose move is more than 100% of the scope's omits its share.
    expect(
      text(
        changeSentence({
          ...base,
          scope: row("X", 100, 90),
          children: [row("a", 50, 20), row("b", 50, 70)],
        })
      )
    ).toContain("a explains 30 h of it.");
    // Between 100% and 150% too: "explains 127% of it" reads wrong.
    const past = text(
      changeSentence({
        ...base,
        scope: row("X", 100, 90),
        children: [row("a", 50, 37), row("b", 50, 53)],
      })
    );
    expect(past).toContain("a explains 13 h of it.");
    expect(past).not.toContain("of it (");
  });
});

// A stub Pricer: $2/h for "lf-l-x86iavx512-16-128" except in a gap week
// (Nov 16–22), every other label unpriced.
function stubPricer(opts: { gap?: [Day, Day] } = {}): Pricer {
  const gap = opts.gap;
  const kind = (day: Day): RateDayKind =>
    gap && day >= gap[0] && day <= gap[1] ? "gap" : "final";
  const rate = (label: string, day: Day) =>
    kind(day) === "gap" || label !== "lf-l-x86iavx512-16-128" ? null : 2;
  return {
    set: {
      file: "stub.json",
      metaFile: null,
      basis: null,
      generatedAt: null,
      legacy: false,
      periods: [],
    },
    today: "2026-11-19",
    rate,
    piece(label: string, days: readonly Day[]): PieceRate {
      const priced = days.filter((d) => rate(label, d) !== null);
      return {
        rate: priced.length ? 2 : null,
        priced: days.length ? priced.length / days.length : 0,
        exact: priced.length === days.length,
        borrowed: false,
      };
    },
    dayKind: kind,
    segments: () => [],
    coverageLine: () => null,
  };
}

describe("$ (stub Pricer)", () => {
  // Hand-checkable: one child, one label, B = Nov 12–18 in two pieces.
  const tiny: CostScope = {
    repo: "pytorch/pytorch",
    workflows: [],
    trail: [],
    by: "o",
    a: { from: "2026-11-05", to: "2026-11-11" },
    b: { from: "2026-11-12", to: "2026-11-18" },
    sides: [
      { days: ["2026-11-05", "2026-11-06"], pushes: [10, 10], filling: [] },
      {
        days: ["2026-11-12", "2026-11-13", "2026-11-16", "2026-11-17"],
        pushes: [10, 30, 20, 40],
        filling: [],
      },
    ],
    pieces: [
      { side: 0, from: "2026-11-05", to: "2026-11-08" },
      { side: 1, from: "2026-11-12", to: "2026-11-15" },
      { side: 1, from: "2026-11-16", to: "2026-11-18" },
    ],
    children: ["inductor"],
    info: [{}],
    labels: ["lf-l-x86iavx512-16-128", "linux.unpriced"],
    cells: [
      [0, 0, 0, 0, 40, 8],
      [1, 1, 0, 0, 60, 12],
      [1, 2, 0, 0, 100, 20],
      [1, 1, 0, 1, 10, 0],
    ],
    tests: [],
    query_duration_ms: 1,
  };

  test("$ = h × rate per piece; per day over priced days", () => {
    const v = levelView(tiny, {
      unit: "usd",
      per: "day",
      pricer: stubPricer(),
    });
    near(v.total.a, (40 * 2) / 2);
    // B: 160 h at $2, 4 priced days; the unpriced label's 10 h stay out.
    near(v.total.b, (160 * 2) / 4);
    expect(v.total.unpricedH).toBeCloseTo(10);
  });

  test("a gap week: per day and per commit count only priced days", () => {
    const pricer = stubPricer({ gap: ["2026-11-16", "2026-11-22"] });
    const day = levelView(tiny, { unit: "usd", per: "day", pricer });
    near(day.total.b, (60 * 2) / 2); // Nov 12–13 priced
    const commit = levelView(tiny, { unit: "usd", per: "commit", pricer });
    near(commit.total.b, (12 * 2) / (10 + 30)); // main $ ÷ pushes of priced days
    near(commit.total.a, (8 * 2) / 20);
  });

  test("hours with no price read blank, never $0", () => {
    const pricer = stubPricer({ gap: ["2026-11-01", "2026-11-30"] });
    const v = levelView(tiny, { unit: "usd", per: "day", pricer });
    expect(v.total.b).toBeNull();
    // A side with days but no rates says so; no data is for no days.
    expect(v.total.blankB).toBe("no rates");
    expect(v.total.blankA).toBe("no rates");
    const noA = levelView(
      {
        ...tiny,
        sides: [{ days: [], pushes: [], filling: [] }, tiny.sides[1]],
      },
      { unit: "usd", per: "day", pricer }
    );
    expect(noA.total.blankA).toBe("no data");
    // In hours a null is no days only.
    const hoursView = levelView(tiny, { unit: "hours", per: "day", pricer });
    expect(hoursView.total.blankB).toBe("–");
  });

  test("a side with fewer priced days than days says so", () => {
    const pricer = stubPricer({ gap: ["2026-11-16", "2026-11-22"] });
    const v = levelView(tiny, { unit: "usd", per: "day", pricer });
    expect(sideChips(v, "2026-10-29")).toContain("B: 2 of 4 days priced");
    expect(sideChips(v, "2026-10-29").join()).not.toContain("A:");
    // Hours never count priced days.
    const h = levelView(tiny, { unit: "hours", per: "day", pricer });
    expect(sideChips(h, "2026-10-29").join()).not.toContain("priced");
  });
});

describe("test level (/cases)", () => {
  const view = casesView(casesOk);

  test("configurations are exact and cells pair across sides", () => {
    expect(view.configs.length).toBeGreaterThan(0);
    const msB = casesOk.configs
      .filter(([s]) => s === 1)
      .reduce((t, c) => t + c[8], 0);
    near(
      view.configs.reduce((t, c) => t + c.B.ms, 0),
      msB,
      0
    );
    expect(view.rankedOf).toBe(casesOk.ranked_of);
    const keys = new Set(view.cells.map((c) => c.key));
    expect(keys.size).toBe(view.cells.length);
  });

  test("the change splits into runs and time per run", () => {
    for (const c of view.cells) {
      if (c.d === null || c.effRun === null || c.effVol === null) continue;
      expect(c.effRun + c.effVol).toBeCloseTo(c.d, 9);
    }
    const s = casesSummary(view.cells);
    expect((s.effRun ?? 0) + (s.effVol ?? 0)).toBeCloseTo(
      s.tB - (s.tA ?? 0),
      6
    );
  });

  test("views filter and count; a configuration narrows the cases", () => {
    const all = filterCases(view, { cfg: null, view: "moves", rank: null });
    expect(all.rows).toHaveLength(view.cells.length);
    for (const v of CASE_VIEW_ORDER)
      expect(all.counts[v]).toBeGreaterThanOrEqual(0);
    const shrank = filterCases(view, { cfg: null, view: "shrank", rank: null });
    expect(shrank.rows.every((r) => (r.effRun ?? 0) < 0)).toBe(true);
    const cfg = view.configs[0].key;
    const narrowed = filterCases(view, { cfg, view: "moves", rank: "day" });
    expect(
      narrowed.rows.every((r) => `${r.envId}:${r.envVarsId}` === cfg)
    ).toBe(true);
  });
});

describe("expand in place", () => {
  const NTR: Pill = { dim: "o", value: NO_TEST_REPORTS };
  const UNK: Pill = { dim: "m", value: UNKNOWN_MACHINE };

  test("what each row opens onto", () => {
    // By owner: an owner its machines, a machine under it its runner labels.
    expect(expansionOf([], "o", "inductor")).toEqual({
      trail: [IND],
      by: "m",
    });
    expect(expansionOf([IND], "m", AVX.value)).toEqual({
      trail: [IND, AVX],
      by: "label",
    });
    // By machine: a machine its owners (or its runner labels when asked),
    // an owner under it its runner labels.
    expect(expansionOf([], "m", AVX.value)).toEqual({
      trail: [AVX],
      by: "o",
    });
    expect(expansionOf([], "m", AVX.value, "label")).toEqual({
      trail: [AVX],
      by: "label",
    });
    expect(expansionOf([AVX], "o", "inductor")).toEqual({
      trail: [AVX, IND],
      by: "label",
    });
    // Buckets open like any row.
    expect(expansionOf([], "o", NO_TEST_REPORTS)).toEqual({
      trail: [NTR],
      by: "m",
    });
    expect(expansionOf([NTR], "m", AVX.value)?.by).toBe("label");
    expect(expansionOf([], "m", UNKNOWN_MACHINE)).toEqual({
      trail: [UNK],
      by: "o",
    });
    // Under a Drill in the same rules: the canvas of inductor lists
    // machines, which open onto runner labels.
    expect(expansionOf([IND], "m", AVX.value, "o")?.by).toBe("label");
  });

  test("a file opens onto its lanes on the machine; lanes and labels open nothing", () => {
    // The pair's files: each onto its environment × workflow lanes, the
    // trail Drill in pins being the file view's (a deep link ending in f:).
    const opened = expansionOf([IND, AVX], "f", FLEX.value);
    expect(opened).toEqual({ trail: [IND, AVX, FLEX], by: "lane" });
    expect(childBy(opened?.trail ?? [], "o")).toBe("lane");
    // A file's machines (inductor's file pinned, no machine) the same.
    expect(expansionOf([IND, FLEX], "m", AVX.value)).toEqual({
      trail: [IND, FLEX, AVX],
      by: "lane",
    });
    // Machine first: the machine's file.
    expect(expansionOf([AVX, IND], "f", FLEX.value)).toEqual({
      trail: [AVX, IND, FLEX],
      by: "lane",
    });
    // No machine in the file's scope (or nothing before it): no lanes.
    expect(expansionOf([IND], "f", FLEX.value)).toBeNull();
    expect(expansionOf([], "f", FLEX.value)).toBeNull();
    // Lanes and runner labels have nothing deeper.
    expect(expansionOf([IND, AVX, FLEX], "lane", "1|pull")).toBeNull();
    expect(expansionOf([IND, AVX], "label", "x|pull")).toBeNull();
    expect(expansionOf([IND, AVX, FLEX], "label", "x|pull")).toBeNull();
  });

  test("an open file's lanes: named by what their environments don't share, summing to the file", () => {
    const v = levelView(file, hours);
    const rows = laneRows(v);
    expect(rows.map((r) => r.key)).toEqual(v.rows.map((r) => r.key));
    // Every lane runs Linux 22.04 x86_64 avx512 on CPU: the names keep
    // Python and the compiler; the workflow stays in detail.
    const shared = laneGroups(v).common;
    expect(shared.length).toBeGreaterThan(0);
    for (const r of rows.filter((x) => !x.hidden)) {
      expect(shared.some((t) => r.name.includes(t))).toBe(false);
      expect(r.name).toMatch(/Python 3\.1/);
    }
    const pullGcc = rows.find((r) => r.key === "14985026198735433233|pull");
    expect(pullGcc?.detail).toBe("pull");
    expect(pullGcc?.name).toContain("GCC 11.4");
    // Numbers untouched: only the names change.
    const raw = rowByKey(v, "14985026198735433233|pull");
    expect([pullGcc?.a, pullGcc?.b, pullGcc?.labels]).toEqual([
      raw?.a,
      raw?.b,
      raw?.labels,
    ]);
    // Opened under the pair's file row: the lanes, by the table's order,
    // with laneRows' names, sum to the file's own row in the pair.
    const fileRow = rowByKey(levelView(pair, hours), FLEX.value);
    const { shown, rest, more, total } = expansionRows(v, "b");
    near(total.b, fileRow?.b ?? 0, 2);
    near(total.a, fileRow?.a ?? 0, 2);
    const listed = [...shown, ...rest];
    near(
      listed.reduce((t, r) => t + (r.b ?? 0), 0),
      total.b ?? 0,
      2
    );
    expect(more === null).toBe(rest.length === 0);
    expect(shown.map((r) => r.key)).toEqual(
      sortRows(
        rows.filter((r) => !r.hidden),
        "b",
        "h",
        true
      )
        .slice(0, shown.length)
        .map((r) => r.key)
    );
    expect(shown[0].name).toBe(rows.find((r) => r.key === shown[0].key)?.name);
    // Each lane carries its B a day per runner label (the row's chips).
    for (const r of listed) {
      near(
        r.labels.reduce((t, l) => t + l.b, 0),
        r.b ?? 0,
        4
      );
    }
  });

  test("only a machine with no owner above it offers Owners | Runners", () => {
    expect(machineSwitches([], "m")).toBe(true);
    expect(machineSwitches([IND], "m")).toBe(false);
    expect(machineSwitches([IND, FLEX], "m")).toBe(false);
    expect(machineSwitches([], "o")).toBe(false);
    expect(machineSwitches([AVX], "o")).toBe(false);
  });

  test("label|workflow children sum per runner label", () => {
    const v = levelView(pairLabel, hours);
    const { rows, keys } = labelRows(v);
    const labels = new Set(
      pairLabel.children.map((c) => c.slice(0, c.lastIndexOf("|")))
    );
    expect(rows.map((r) => r.key).sort()).toEqual([...labels].sort());
    expect(rows.length).toBeLessThan(pairLabel.children.length);
    const big = rows.find((r) => r.key === "mt-l-x86iavx512-16-128");
    expect(big?.by).toBe("label");
    expect(big?.name).toBe("mt-l-x86iavx512-16-128");
    expect(big?.detail).toContain("pull");
    const own = keys.get("mt-l-x86iavx512-16-128") ?? [];
    expect(own.length).toBeGreaterThan(1);
    expect(own.every((k) => k.startsWith("mt-l-x86iavx512-16-128|"))).toBe(
      true
    );
    // Each label is the sum of its workflows' rows; the labels sum to the
    // scope.
    const sumOf = (ks: string[], side: "a" | "b") =>
      ks.reduce((t, k) => t + (rowByKey(v, k)?.[side] ?? 0), 0);
    near(big?.b ?? null, sumOf(own, "b"));
    near(big?.a ?? null, sumOf(own, "a"));
    near(
      rows.reduce((t, r) => t + (r.b ?? 0), 0),
      v.total.b ?? 0
    );
  });

  test("an open row's children sum to it; values read their share of it", () => {
    // inductor at the owner root, opened onto its machines (scope_owner).
    const rootView = levelView(root, hours);
    const inductor = rowByKey(rootView, "inductor");
    const machines = levelView(owner, hours);
    const { shown, rest, more, buckets, total } = expansionRows(
      machines,
      "change"
    );
    near(total.b, inductor?.b ?? 0, 2);
    near(total.a, inductor?.a ?? 0, 2);
    expect(shown).toHaveLength(NESTED_TOP);
    expect(more).not.toBeNull();
    const listed = [...shown, ...rest, ...buckets];
    near(
      listed.reduce((t, r) => t + (r.b ?? 0), 0),
      total.b ?? 0,
      2
    );
    near(
      more?.b ?? null,
      rest.reduce((t, r) => t + (r.b ?? 0), 0)
    );
    // Sorted within the level by the table's order.
    expect(shown).toEqual(
      sortRows(
        machines.rows.filter((r) => !r.hidden && !r.bucket),
        "change",
        "h",
        true
      ).slice(0, NESTED_TOP)
    );
    // avx512 within inductor: 4,842 h a day, 41% of inductor's B; its
    // runner labels sum to it.
    const avx = rowByKey(machines, AVX.value);
    near(avx?.b ?? null, 4842.36, 1);
    expect(Math.round(((avx?.b ?? 0) / (total.b ?? 1)) * 100)).toBe(41);
    const labels = expansionRows(levelView(pairLabel, hours), "b");
    near(labels.total.b, avx?.b ?? 0, 2);
    expect(labels.more).toBeNull(); // five labels: none folded
    expect(labels.shown.map((r) => r.key)[0]).toBe("mt-l-x86iavx512-16-128");
    expect(
      Math.round(((labels.shown[0].b ?? 0) / (labels.total.b ?? 1)) * 100)
    ).toBe(51);
  });

  test("nested rows price with the same pricer, per day over the side's days", () => {
    const v = levelView(pairLabel, {
      unit: "usd",
      per: "day",
      pricer: stubPricer(),
    });
    const { rows } = labelRows(v);
    const priced = rows.find((r) => r.key === "lf-l-x86iavx512-16-128");
    const hoursB = levelView(pairLabel, hours);
    const lfHoursB = labelRows(hoursB).rows.find(
      (r) => r.key === "lf-l-x86iavx512-16-128"
    );
    // $2/h on every B day: the label's B hours a day × 2.
    near(priced?.b ?? null, (lfHoursB?.b ?? 0) * 2, 4);
    // Unpriced labels read blank, never $0.
    const unpriced = rows.find((r) => r.key === "mt-l-x86iavx512-16-128");
    expect(unpriced?.b).toBeNull();
    expect(unpriced?.blankB).toBe("no rates");
  });
});

describe("page facts: V1's headline numbers", () => {
  // The root trend: daily cells Oct 15 – Nov 19, Nov 19 still filling. Day i
  // holds 10 + i h on a priced label (2 of them on pushes to main) and 1 h
  // on one without rates, with 10 pushes; the owner cells 30 h of inductor
  // and 10 h unattributed a day, plus 1000 h unattributed on Oct 21 (before
  // the window) and on the filling day.
  const LF = "lf-l-x86iavx512-16-128";
  const DAYS = Array.from({ length: 36 }, (_, i) => addDays("2026-10-15", i));
  function trendOf(
    first = 0,
    opts: { filling?: boolean; pushes?: number } = {}
  ): CostTrend {
    const days = DAYS.slice(first);
    const at = (d: Day) => DAYS.indexOf(d);
    return {
      repo: "pytorch/pytorch",
      rollup: "day",
      workflows: [],
      start: DAYS[0],
      end: "2026-11-20",
      periods: DAYS,
      owners: ["inductor", "unattributed:no_test_reports"],
      labels: [LF, "mt-l-x86iavx512-16-128"],
      cells: [
        ...days.flatMap(
          (d) =>
            [
              [at(d), 0, 0, 30, 0],
              [at(d), 1, 0, 10, 0],
            ] as CostTrend["cells"]
        ),
        [6, 1, 0, 1000, 0],
        [35, 1, 0, 1000, 0],
      ],
      daily: {
        start: "2026-01-01",
        days,
        filling: opts.filling === false ? [] : ["2026-11-19"],
        pushes: days.map(() => opts.pushes ?? 10),
        cells: days.flatMap(
          (d, i) =>
            [
              [i, 0, 10 + at(d), 2],
              [i, 1, 1, 0],
            ] as CostTrend["daily"]["cells"]
        ),
      },
      query_duration_ms: 1,
    };
  }
  // Oct 22 – Nov 18 is i = 7..34: Σ (10 + i) = 280 + 574 = 854.
  const LAST28 = 854;

  test("the window: the last 28 whole days, the filling day out; fewer while the data holds fewer", () => {
    const facts = pageFacts(trendOf(), "hours", null);
    expect(facts.days).toHaveLength(FACTS_DAYS);
    expect(facts.days[0]).toBe("2026-10-22");
    expect(facts.days[27]).toBe("2026-11-18");
    expect(facts.window).toBe("Last 28 days, Oct 22 – Nov 18");
    // Nov 19 whole: the window moves a day.
    expect(
      pageFacts(trendOf(0, { filling: false }), "hours", null).window
    ).toBe("Last 28 days, Oct 23 – Nov 19");
    // Data from Oct 29 (i = 14): the 21 whole days there are.
    const late = pageFacts(trendOf(14), "hours", null);
    expect(late.days).toHaveLength(21);
    expect(late.window).toBe("Last 21 days, Oct 29 – Nov 18");
    expect(windowText(["2026-11-18"])).toBe("Last day, Nov 18");
    expect(windowText(["2026-11-01", "2026-11-18"])).toBe(
      "Last 2 days, Nov 1–18"
    );
    expect(recentDays(trendDaily(trendOf(35)))).toEqual([]);
  });

  test("per day, a year, per commit and owners, in hours", () => {
    const facts = pageFacts(trendOf(), "hours", null);
    near(facts.perDay.value, (LAST28 + 28) / 28);
    expect(facts.perDay.approx).toBe(false);
    expect(facts.perDay.priced).toBeNull();
    // Per commit: push:main hours ÷ pushes to main over the window.
    near(facts.perCommit.value, (2 * 28) / (10 * 28));
    expect(facts.perCommit.pushes).toBe(280);
    // Owners: the window's days only, not Oct 21 or the filling day.
    near(facts.owned, 30 / 40);
    // No pushes: per commit is blank; no whole days: nothing is said.
    const noPushes = pageFacts(trendOf(0, { pushes: 0 }), "hours", null);
    expect(noPushes.perCommit.value).toBeNull();
    expect(noPushes.perCommit.blank).toBe("–");
    const none = pageFacts(trendOf(35), "hours", null);
    expect(none.window).toBeNull();
    expect(none.perDay).toEqual({
      value: null,
      approx: false,
      priced: null,
      blank: "no data",
    });
    expect(none.owned).toBeNull();
  });

  test("in $ each day at its own rates: ≈ for a gap or a borrowed day, no rates for none", () => {
    const full = pageFacts(trendOf(), "usd", stubPricer());
    // The label without rates adds no $.
    near(full.perDay.value, (LAST28 * 2) / 28);
    near(full.perCommit.value, (2 * 2 * 28) / 280);
    expect(full.perDay.approx).toBe(false);
    expect(full.perDay.priced).toBeNull();
    // No rates from Nov 16: Oct 22 – Nov 15 (i = 7..31) priced, Σ = 725,
    // over their 25 days and their 250 pushes.
    const gap = pageFacts(
      trendOf(),
      "usd",
      stubPricer({ gap: ["2026-11-16", "2026-11-30"] })
    );
    near(gap.perDay.value, (725 * 2) / 25);
    near(gap.perCommit.value, (2 * 2 * 25) / 250);
    expect(gap.perDay.approx).toBe(true);
    expect(gap.perCommit.approx).toBe(true);
    expect(gap.perDay.priced).toEqual({ days: 25, of: 28 });
    expect(gap.perCommit.pushes).toBe(250);
    const lent = stubPricer();
    const borrowed: Pricer = {
      ...lent,
      dayKind: (d) => (d >= "2026-11-17" ? "borrowed" : "final"),
    };
    const b = pageFacts(trendOf(), "usd", borrowed);
    near(b.perDay.value, full.perDay.value as number);
    expect(b.perDay.approx).toBe(true);
    expect(b.perDay.priced).toBeNull();
    const none = pageFacts(
      trendOf(),
      "usd",
      stubPricer({ gap: ["2026-10-01", "2026-11-30"] })
    );
    expect(none.perDay.value).toBeNull();
    expect(none.perDay.blank).toBe("no rates");
    expect(none.perCommit.blank).toBe("no rates");
    expect(none.perDay.approx).toBe(false);
    // Owners stay a share of hours.
    near(none.owned, 30 / 40);
    // Hours whatever the pricer when the unit is hours.
    near(
      pageFacts(trendOf(), "hours", stubPricer()).perDay.value,
      (LAST28 + 28) / 28
    );
  });

  test("attributed to owners: the trend's days in a range", () => {
    const periods = Array.from(
      { length: 9 },
      (_, i) => `2026-11-${String(10 + i).padStart(2, "0")}`
    );
    const trend = {
      repo: "pytorch/pytorch",
      rollup: "day",
      workflows: [],
      start: "2026-11-10",
      end: "2026-11-19",
      periods,
      owners: ["inductor", "unattributed:no_owner"],
      labels: ["x"],
      cells: [
        [2, 0, 0, 30, 0], // Nov 12
        [8, 1, 0, 10, 0], // Nov 18
        [0, 0, 0, 100, 0], // Nov 10, before the range
      ],
      daily: {
        start: "2026-01-01",
        days: [],
        filling: [],
        pushes: [],
        cells: [],
      },
      query_duration_ms: 1,
    } as CostTrend;
    const range = { from: "2026-11-12", to: "2026-11-18" };
    near(ownedShareOfTrend(trend, range), 30 / 40);
    // A range outside the trend's days, or weeks: not said.
    expect(
      ownedShareOfTrend(trend, { ...range, from: "2026-11-09" })
    ).toBeNull();
    expect(ownedShareOfTrend(trend, { ...range, to: "2026-11-19" })).toBeNull();
    expect(ownedShareOfTrend({ ...trend, rollup: "week" }, range)).toBeNull();
    expect(ownedShareOfTrend({ ...trend, cells: [] }, range)).toBeNull();
  });
});
