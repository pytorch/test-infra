// The Trends panel (components/tests/cost/trends) from trend.json (a day
// answer ending Nov 5: cells Oct 22 – Nov 4) read as words under SSR, and
// driven through its handlers with react-test-renderer: a click places B, A
// arms with its key, Esc mid-drag restores (and calls preventDefault), a
// drag writes once on release, and no hint beyond the one foot line shows.

import TrendsPanel, {
  disclosures,
  pricedNote,
} from "components/tests/cost/trends/TrendsPanel";
import type {
  BarsScope,
  CostSeries,
  TrendsPanelProps,
  TrendsQuery,
} from "lib/api/tests/cost/contracts";
import { CostTrendSchema } from "lib/api/tests/cost/types";
import { foldBars, trendDayCells } from "lib/tests/cost/fold";
import { makePricer, parseRatesFiles } from "lib/tests/cost/ratePeriods";
import { prepareRunnerHours } from "lib/tests/cost/runnerHours";
import {
  resolveCompare,
  shownRange,
  trendContext,
} from "lib/tests/cost/select";
import { trendStacks } from "lib/tests/cost/stacks";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import ANSWER_JSON from "./answer.json";
import SERIES_OWNER from "./series_owner.json";
import TREND_JSON from "./trend.json";

// The Show key as its props and its words: its menu is MUI's, whose popover
// listens on a browser's window, which these tests have none of.
jest.mock("components/tests/HeaderSelect", () => ({
  __esModule: true,
  default: function HeaderSelect(props: { label: string; display: string }) {
    return require("react").createElement(
      "button",
      { "aria-label": `${props.label}: ${props.display}` },
      props.display
    );
  },
}));

// The breakdown card is MUI's Popper, which needs a document.
jest.mock("components/tests/cost/trends/TrendTooltip", () => ({
  __esModule: true,
  ...jest.requireActual("components/tests/cost/trends/TrendTooltip"),
  default: function TrendTooltip(props: { open: boolean; bar: number }) {
    return props.open
      ? require("react").createElement("output", null, `tooltip ${props.bar}`)
      : null;
  },
}));

const answer = CostTrendSchema.parse(TREND_JSON);
const ctx = trendContext(answer);
const runnerHours = prepareRunnerHours(ANSWER_JSON as never);
const ROOT: BarsScope = {
  trail: [],
  root: "o",
  by: "o",
  fromTrend: true,
  preview: false,
  hover: null,
};
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

function props(patch: Partial<TrendsPanelProps> = {}): TrendsPanelProps {
  const q = patch.query ?? query();
  return {
    answer,
    context: ctx,
    loading: false,
    query: q,
    compare: resolveCompare(q, ctx),
    onQueryChange: jest.fn(),
    pricer: null,
    runnerHours,
    scope: ROOT,
    series: undefined,
    seriesLoading: false,
    workflowScope: null,
    slots: {},
    ...patch,
  };
}

function words(markup: string): string {
  return markup
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("TrendsPanel under SSR", () => {
  const markup = renderToStaticMarkup(<TrendsPanel {...props()} />);
  const text = words(markup);

  it("draws the band and the pick and quick rows, with no hint line", () => {
    expect(text).toContain("Trends");
    // The band says the workflow scope only: no "last N days" or "since".
    expect(text).toContain("Trends · all workflows Day Week Month");
    expect(text).toContain("Pick A Nov 3 · 1 day B Nov 4 · 1 day ⇄ Swap");
    expect(text).toContain(
      "Quick Day over day Week over week Month over month Last 7 vs prior 7 Last 28 vs prior 28"
    );
    // How to pick periods is behind the band's (i), not on the page.
    expect(text).not.toContain("Click a bar to place");
    // A and B on neighbouring bars: the tabs keep their letters; the live
    // line says B's figure.
    expect(text).toContain("B: Nov 4, 1 day, 38 h a day, ±0% vs A");
  });

  it("disables MoM, WoW and 28v28 on the fixture's dates", () => {
    const chip = (label: string) =>
      markup.match(new RegExp(`<[^>]*aria-[^>]*>${label}<`))?.[0] ?? "";
    expect(chip("Day over day")).toContain('aria-pressed="true"');
    expect(chip("Last 7 vs prior 7")).not.toContain("aria-disabled");
    for (const label of [
      "Week over week",
      "Month over month",
      "Last 28 vs prior 28",
    ]) {
      expect(chip(label)).toContain('aria-disabled="true"');
    }
  });

  it("keeps the band's (i) to three short lines, true to how A and B read", () => {
    const tip = /aria-label="(Test-job runner-hours[^"]*)"/.exec(markup)?.[1];
    expect(tip).toBeDefined();
    expect(tip!.split("\n").length).toBeLessThanOrEqual(3);
    expect(tip!.split(/\s+/).length).toBeLessThanOrEqual(30);
    // A, B and the drill count a partial bar as one whole bar.
    expect(tip).not.toMatch(/share of days/);
    // No data start date, which would grow stale.
    expect(tip).not.toMatch(/starts|before the first day|not tracked/i);
  });

  it("has no coach, toast, keycaps or Shift-drag caption", () => {
    for (const gone of [
      "Shift-drag",
      "Got it",
      "Show me",
      "Skip",
      "Release to set",
      "Drag to stretch",
      "set to",
      "Swapped",
      "Faded bars",
    ]) {
      expect(text).not.toContain(gone);
    }
  });

  it("keeps the last bars dimmed while a scope's series loads", () => {
    const loading = renderToStaticMarkup(
      <TrendsPanel
        {...props({
          scope: {
            ...ROOT,
            trail: [{ dim: "o", value: "inductor" }],
            by: "m",
            fromTrend: false,
          },
          seriesLoading: true,
        })}
      />
    );
    expect(loading).toContain("opacity:0.5");
    expect(words(loading)).toContain("inductor"); // the owner stack stays meanwhile
  });

  it("stacks a scope's series by machine (the live inductor answer)", () => {
    const series = SERIES_OWNER as unknown as CostSeries;
    const end = "2026-11-19";
    const c = {
      ...ctx,
      end,
      lastFull: "2026-11-18",
      days: new Set(series.days),
      filling: new Set(["2026-11-18"]),
      firstDay: series.days[0],
    };
    const q = query({
      a: { from: "2026-11-05", to: "2026-11-11" },
      b: { from: "2026-11-12", to: "2026-11-18" },
    });
    const text = words(
      renderToStaticMarkup(
        <TrendsPanel
          {...props({
            context: c,
            query: q,
            compare: resolveCompare(q, c),
            scope: {
              ...ROOT,
              trail: [{ dim: "o", value: "inductor" }],
              by: "m",
              fromTrend: false,
            },
            series,
          })}
        />
      )
    );
    expect(text).toContain("Linux x86_64 avx512");
    expect(text).toContain("Other machines");
    expect(text).not.toContain("Unknown machine"); // none in this answer
    // Inductor 14.4K → 11.8K h a day.
    expect(text).toContain("A · 14.4K h a day");
    expect(text).toContain("B · 11.8K h a day");
    expect(text).toContain("Nov 18 is still filling");
  });

  it("reads week bars as totals and A and B a week (the live inductor answer)", () => {
    const series = SERIES_OWNER as unknown as CostSeries;
    const end = "2026-11-19";
    const c = {
      ...ctx,
      end,
      lastFull: "2026-11-18",
      days: new Set(series.days),
      filling: new Set(["2026-11-18"]),
      firstDay: series.days[0],
    };
    const q = query({
      rollup: "week",
      a: { from: "2026-11-02", to: "2026-11-08" },
      b: { from: "2026-11-09", to: "2026-11-15" },
    });
    const text = words(
      renderToStaticMarkup(
        <TrendsPanel
          {...props({
            context: c,
            query: q,
            compare: resolveCompare(q, c),
            scope: {
              ...ROOT,
              trail: [{ dim: "o", value: "inductor" }],
              by: "m",
              fromTrend: false,
            },
            series,
          })}
        />
      )
    );
    // Whole weeks: a week is the week's sum, 121.5K → 82.8K h (−32%).
    expect(text).toContain("A · 121.5K h a week");
    expect(text).toContain("B · 82.8K h a week");
    expect(text).toContain("▼ 32% vs A");
    // The axis is in the bars' unit: week sums reach past 100K h.
    expect(text).toMatch(/\b1[0-9]0K h\b/);
    expect(text).toContain("Total Per commit");
    expect(text).not.toContain("Per day");
  });
});

// A node with a box: 960 px wide, so 42 bars of (960 − 64) / 42 px.
const nodeMock = (element: { props: Record<string, unknown> }) => ({
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 300 }),
  focus: () => {},
  setPointerCapture: () => {},
  // MUI's Tooltip reads back the attribute it put on its child.
  getAttribute: (name: string) => element.props[name] ?? null,
  setAttribute: () => {},
  removeAttribute: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  style: {},
});
const SLOT = (960 - 64) / 42;
const barX = (i: number) => 56 + (i + 0.5) * SLOT;
const pointer = (x: number, extra: object = {}) => ({
  button: 0,
  clientX: x,
  clientY: 120,
  pointerId: 1,
  pointerType: "mouse",
  shiftKey: false,
  preventDefault: () => {},
  ...extra,
});

function mount(p: TrendsPanelProps) {
  let r!: ReturnType<typeof create>;
  act(() => {
    r = create(<TrendsPanel {...p} />, { createNodeMock: nodeMock });
  });
  const svg = () =>
    r.root.find(
      (n: ReactTestInstance) =>
        n.type === "svg" && n.props.onPointerDown !== undefined
    );
  const group = () =>
    r.root.find(
      (n: ReactTestInstance) =>
        typeof n.type === "string" && n.props.role === "group"
    );
  const chips = () =>
    r.root
      .findAll(
        (n: ReactTestInstance) =>
          typeof n.type === "string" && n.props["aria-pressed"] !== undefined
      )
      .map((n) => n.props["aria-pressed"]);
  return { r, svg, group, chips };
}

describe("TrendsPanel gestures", () => {
  // Bar 40 is Nov 3 (bars run Sep 24 – Nov 4).
  it("places B with a click and writes only a and b", () => {
    const p = props();
    const { svg } = mount(p);
    act(() => svg().props.onPointerDown(pointer(barX(30))));
    act(() => svg().props.onPointerUp(pointer(barX(30))));
    expect(p.onQueryChange).toHaveBeenCalledTimes(1);
    expect(p.onQueryChange).toHaveBeenCalledWith({
      rollup: "day",
      cmp: null,
      a: { from: "2026-11-03", to: "2026-11-03" },
      b: { from: "2026-10-24", to: "2026-10-24" },
    });
  });

  it("arms A with its key and moves it with the arrows", () => {
    const p = props();
    const { group, chips } = mount(p);
    const key = (k: string, extra: object = {}) => ({
      key: k,
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      target: {},
      defaultPrevented: false,
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
      ...extra,
    });
    act(() => group().props.onKeyDown(key("a")));
    expect(chips().slice(0, 2)).toEqual([true, false]);
    act(() => group().props.onKeyDown(key("ArrowLeft")));
    expect(p.onQueryChange).toHaveBeenLastCalledWith({
      rollup: "day",
      cmp: null,
      a: { from: "2026-11-02", to: "2026-11-02" },
      b: { from: "2026-11-04", to: "2026-11-04" },
    });
  });

  it("restores A/B on Esc mid-drag and calls preventDefault", () => {
    const p = props();
    const { svg, group, r } = mount(p);
    act(() => svg().props.onPointerDown(pointer(barX(20))));
    act(() => svg().props.onPointerMove(pointer(barX(25))));
    // Live: B's chip reads the drawn days while the drag runs.
    expect(words(JSON.stringify(r.toJSON()))).toContain("Oct 14 – Oct 19");
    const esc = {
      key: "Escape",
      target: {},
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    };
    act(() => group().props.onKeyDown(esc));
    expect(esc.preventDefault).toHaveBeenCalled();
    act(() => svg().props.onPointerUp(pointer(barX(25))));
    expect(p.onQueryChange).not.toHaveBeenCalled();
    expect(words(JSON.stringify(r.toJSON()))).not.toContain("Oct 14 – Oct 19");
  });

  it("writes a drag once, on release", () => {
    const p = props();
    const { svg } = mount(p);
    act(() => svg().props.onPointerDown(pointer(barX(20))));
    act(() => svg().props.onPointerMove(pointer(barX(22))));
    act(() => svg().props.onPointerMove(pointer(barX(25))));
    expect(p.onQueryChange).not.toHaveBeenCalled();
    act(() => svg().props.onPointerUp(pointer(barX(25))));
    expect(p.onQueryChange).toHaveBeenCalledTimes(1);
    expect(p.onQueryChange).toHaveBeenCalledWith(
      expect.objectContaining({ b: { from: "2026-10-14", to: "2026-10-19" } })
    );
  });

  it("treats a 3 px wobble as a click", () => {
    const p = props();
    const { svg } = mount(p);
    act(() => svg().props.onPointerDown(pointer(barX(30))));
    act(() => svg().props.onPointerMove(pointer(barX(30) + 3)));
    act(() => svg().props.onPointerUp(pointer(barX(30) + 3)));
    expect(p.onQueryChange).toHaveBeenCalledWith(
      expect.objectContaining({ b: { from: "2026-10-24", to: "2026-10-24" } })
    );
  });
});

describe("disclosures", () => {
  const shown = shownRange("day", 42, ctx.end);
  const folded = foldBars(trendDayCells(answer), "day", shown, ctx);
  const stacks = trendStacks(folded, {
    repo: "pytorch/pytorch",
    unit: "hours",
    per: "commit",
    pricer: null,
    scope: ROOT,
    colored: [],
  });
  it("orders filling, coverage, weekends, overlap and per-commit noise", () => {
    const items = disclosures({
      folded,
      stacks,
      sel: {
        rollup: "day",
        a: { from: "2026-10-01", to: "2026-10-03" },
        b: { from: "2026-10-03", to: "2026-10-03" },
        preset: null,
      },
      per: "commit",
      unit: "hours",
      pricer: null,
      context: { ...ctx, filling: new Set(["2026-11-04"]) },
    });
    expect(items).toEqual([
      "Nov 4 is still filling (reads low until the 03:30 UTC rerun)",
      "A has no data, B has no data",
      "A and B overlap by 1 day",
    ]);
  });

  it("says a side before the data has no data, with no start date", () => {
    const items = disclosures({
      folded,
      stacks,
      sel: {
        rollup: "day",
        a: { from: "2026-10-01", to: "2026-10-07" },
        b: { from: "2026-11-03", to: "2026-11-03" },
        preset: null,
      },
      per: "day",
      unit: "hours",
      pricer: null,
      context: { ...ctx, firstDay: "2026-10-22" },
    });
    expect(items).toContain("A has no data");
    expect(items.join(" · ")).not.toMatch(/starts|Oct 22/);
  });
});

describe("priced days", () => {
  it("notes a side with fewer priced days than days, never one with none", () => {
    expect(pricedNote({ days: 7, pricedDays: 3 })).toBe("3 of 7 days priced");
    expect(pricedNote({ days: 7, pricedDays: 7 })).toBeNull();
    expect(pricedNote({ days: 7, pricedDays: 0 })).toBeNull();
  });
});

describe("disclosures in $ (gap file)", () => {
  const pricer = makePricer(
    parseRatesFiles([
      {
        name: "rates_FAKE_weekly_gap.json",
        text: readFileSync(
          join(__dirname, "rates_FAKE_weekly_gap.json"),
          "utf8"
        ),
      },
    ])
  );
  const shown = shownRange("month", 12, ctx.end);
  const folded = foldBars(trendDayCells(answer), "month", shown, ctx);
  const stacks = trendStacks(folded, {
    repo: "pytorch/pytorch",
    unit: "usd",
    per: "day",
    pricer,
    scope: ROOT,
    colored: [],
  });
  it("says how many of B's days are priced and lists gaps only from the data start", () => {
    const items = disclosures({
      folded,
      stacks,
      sel: {
        rollup: "month",
        a: { from: "2026-10-01", to: "2026-10-31" },
        b: { from: "2026-11-01", to: "2026-11-30" },
        preset: null,
      },
      per: "day",
      unit: "usd",
      pricer,
      context: ctx,
    });
    const text = items.join(" · ");
    // Nov 1 has rates; Nov 2–4 fall in the file's Nov 2–8 gap.
    expect(text).toContain("B: 1 of 4 days priced");
    // The file starts Oct 19; days before the data never read as gaps.
    const rates = items.find((i) => i.startsWith("Rates "))!;
    expect(rates).toContain("no rates");
    const firstGap = rates.match(/· ([A-Z][a-z]{2} \d+)[^·]*no rates/)?.[1];
    expect(firstGap).toBeDefined();
    expect(Date.parse(`${firstGap} 2026`)).toBeGreaterThanOrEqual(
      Date.parse(`${ctx.firstDay}T00:00:00`)
    );
  });
});
