// A/B windows with a workflow scope (the PR Critical Path, pull and trunk,
// written in any order): the URL's scope reaches every request sorted, so
// one scope is one URL, and only answers echoing it count; switching the
// scope keeps A/B; A/B, presets and gestures (A never equals B) behave as
// for every workflow, the presets by the scope's own days; and the Trends
// panel, the drill, the headline facts and the coverage banner drawn with
// a scope.

import CoverageBanner from "components/tests/cost/banner/CoverageBanner";
import DrillTable from "components/tests/cost/drill/DrillTable";
import ScopeHead from "components/tests/cost/drill/ScopeHead";
import ScopeTrail from "components/tests/cost/drill/ScopeTrail";
import {
  type DrillModel,
  useDrill,
} from "components/tests/cost/drill/useDrill";
import PageFacts from "components/tests/cost/PageFacts";
import TrendsPanel from "components/tests/cost/trends/TrendsPanel";
import {
  addDays,
  type BarsScope,
  costCasesUrl,
  type CostCoverage,
  type CostCoverageJobs,
  costCoverageJobsUrl,
  costCoverageUrl,
  type CostScope,
  costScopeUrl,
  type CostSeries,
  costSeriesUrl,
  costTrendDaysUrl,
  coverageEcho,
  current,
  type Day,
  type DayRange,
  type DrillQuery,
  jobsWindow,
  type Pill,
  type Pricer,
  type Rollup,
  scopeEcho,
  seriesEcho,
  trendEcho,
  type TrendsPanelProps,
  type TrendsQuery,
  type Unit,
} from "lib/api/tests/cost/contracts";
import { type CostTrend, CostTrendSchema } from "lib/api/tests/cost/types";
import { pageFacts } from "lib/tests/cost/drill";
import { costUrlParams, resolveCostQuery } from "lib/tests/cost/query";
import { makePricer, parseRatesFiles } from "lib/tests/cost/ratePeriods";
import {
  comparePresets,
  resolveCompare,
  sameRange,
  trendContext,
} from "lib/tests/cost/select";
import { type CostRouter, costUrlWriter } from "lib/tests/cost/urlState";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { SWRConfig } from "swr";
import JOBS_JSON from "./coverage_jobs.json";
import TESTS_JSON from "./coverage_tests.json";
import FILE from "./scope_file.json";
import OWNER from "./scope_owner.json";
import PAIR from "./scope_pair.json";
import ROOT_SCOPE from "./scope_root.json";
import SERIES_OWNER from "./series_owner.json";
import TREND_JSON from "./trend.json";

// The Show key as a button and the bar card as a line: MUI's menus and
// poppers want a browser.
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
jest.mock("components/tests/cost/trends/TrendTooltip", () => ({
  __esModule: true,
  ...jest.requireActual("components/tests/cost/trends/TrendTooltip"),
  default: () => null,
}));

// The banner's /coverage answers come from mockCoverage (the captured answer
// with 40% of its test hours moved outside the scope, echoing the scope it
// was asked for unless mockCoverageEcho says otherwise); every other request
// goes through SWR as usual.
const mockAsked: string[] = [];
let mockCoverageEcho: string[] | null = null;
function mockCoverage(url: string) {
  mockAsked.push(url);
  const params = new URL(url, "http://hud").searchParams;
  const jobs = JOBS_JSON as unknown as CostCoverageJobs;
  const tests = TESTS_JSON as unknown as CostCoverage;
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const data = url.startsWith("/api/tests/cost/coverage/jobs")
    ? from === jobs.from && to === jobs.to
      ? jobs
      : { ...jobs, from, to, cells: [] }
    : {
        ...tests,
        workflows: mockCoverageEcho ?? params.getAll("workflow"),
        cells: tests.cells.flatMap(([d, s, l, h]) => [
          [d, s, l, h * 0.6],
          [d, 3, l, h * 0.4],
        ]),
      };
  return {
    data,
    error: undefined,
    isLoading: false,
    retrying: false,
    retry: () => Promise.resolve(),
  };
}
jest.mock("lib/tests/useApiResource", () => {
  const actual = jest.requireActual("lib/tests/useApiResource");
  return {
    ...actual,
    useApiResource: (url: string | null, ...rest: unknown[]) =>
      url !== null && url.startsWith("/api/tests/cost/coverage")
        ? mockCoverage(url)
        : actual.useApiResource(url, ...rest),
  };
});

const REPO = "pytorch/pytorch";
// The PR Critical Path as a URL may list it, and as every answer echoes it.
const PR = ["trunk", "pull"];
const SORTED = ["pull", "trunk"];
const A = { from: "2026-11-05", to: "2026-11-11" };
const B = { from: "2026-11-12", to: "2026-11-18" };
const IND: Pill = { dim: "o", value: "inductor" };
const AVX: Pill = { dim: "m", value: "Linux x86_64 avx512" };
const FLEX: Pill = { dim: "f", value: "test/inductor/test_flex_attention.py" };
const ROOT_BARS: BarsScope = {
  trail: [],
  root: "o",
  by: "o",
  fromTrend: true,
  preview: false,
  hover: null,
};
const withoutWorkflows = (url: string) => url.replace(/&workflow=[^&]*/g, "");

// trend.json (a day answer ending Nov 5) for every workflow, and the PR
// Critical Path's: the same days, half the hours.
const ALL = CostTrendSchema.parse(TREND_JSON);
const half = <T extends readonly number[]>(cell: T, at: number[]): T =>
  cell.map((v, i) => (at.includes(i) ? v / 2 : v)) as unknown as T;
const SCOPED: CostTrend = {
  ...ALL,
  workflows: SORTED,
  cells: ALL.cells.map((c) => half(c, [3, 4])),
  daily: { ...ALL.daily, cells: ALL.daily.cells.map((c) => half(c, [2, 3])) },
};

function words(markup: string): string {
  return markup
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, "")
    .replace(/<wbr\/?>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const QUERY: TrendsQuery = {
  rollup: "day",
  show: null,
  cmp: null,
  a: null,
  b: null,
  per: "day",
  unit: "hours",
};

describe("the scope in the URL and in every request", () => {
  test("the URL's scope reads lowercase in its order; every scoped request lists it sorted, so one scope is one URL", () => {
    const q = resolveCostQuery({
      workflow: ["Trunk", "pull"],
      a: "2026-11-05..2026-11-11",
      b: "2026-11-12..2026-11-18",
    });
    expect(q.workflows).toEqual(PR);
    expect(costUrlParams(q).workflow).toEqual(PR);
    const urls = (w: readonly string[]) => [
      costTrendDaysUrl(REPO, w, 49),
      costScopeUrl(REPO, w, A, B, [], "o"),
      costScopeUrl(REPO, w, A, B, [IND, AVX], "f", "day"),
      costSeriesUrl(REPO, w, [IND], "m", { from: "2026-10-08", to: B.to }),
      costCoverageUrl(REPO, w, B),
    ];
    expect(urls(q.workflows)).toEqual(urls(SORTED));
    for (const url of urls(q.workflows)) {
      expect(url.endsWith("&workflow=pull&workflow=trunk")).toBe(true);
      // Nothing else in the request moves with the scope.
      expect(urls([])).toContain(withoutWorkflows(url));
    }
    for (const url of urls([])) expect(url).not.toContain("workflow=");
    expect(urls(["pull"])).not.toEqual(urls(SORTED));
    // The cases are every workflow's and trigger's, and the jobs strip the
    // organization's: neither takes the scope.
    expect(costCasesUrl(REPO, FLEX.value, AVX.value, A, B)).not.toContain(
      "workflow="
    );
    expect(costCoverageJobsUrl(REPO, B)).not.toContain("workflow=");
  });

  test("an answer is current only for its own scope: echoes sorted, a kept answer of another scope never counts", () => {
    const trendUrl = (w: readonly string[]) =>
      costTrendDaysUrl(REPO, w, SCOPED.periods.length);
    expect(current(SCOPED, trendUrl(PR), trendEcho)).toBe(SCOPED);
    expect(current(SCOPED, trendUrl([]), trendEcho)).toBeUndefined();
    expect(current(ALL, trendUrl(PR), trendEcho)).toBeUndefined();
    expect(current(SCOPED, trendUrl(["pull"]), trendEcho)).toBeUndefined();

    const scope = {
      ...(ROOT_SCOPE as unknown as CostScope),
      workflows: SORTED,
      piece: "week",
    } as CostScope;
    const scopeUrl = (w: readonly string[], piece?: "day") =>
      costScopeUrl(REPO, w, A, B, [], "o", piece);
    expect(current(scope, scopeUrl(PR), scopeEcho)).toBe(scope);
    expect(current(scope, scopeUrl([]), scopeEcho)).toBeUndefined();
    // In $ the drill asks for day pieces: a week answer isn't that.
    expect(current(scope, scopeUrl(PR, "day"), scopeEcho)).toBeUndefined();
    const day = { ...scope, piece: "day" } as CostScope;
    expect(current(day, scopeUrl(PR, "day"), scopeEcho)).toBe(day);

    const series = {
      ...(SERIES_OWNER as unknown as CostSeries),
      workflows: SORTED,
    };
    const seriesUrl = (w: readonly string[]) =>
      costSeriesUrl(REPO, w, series.trail, series.by, series);
    expect(current(series, seriesUrl(PR), seriesEcho)).toBe(series);
    expect(current(series, seriesUrl([]), seriesEcho)).toBeUndefined();

    const coverage = {
      ...(TESTS_JSON as unknown as CostCoverage),
      workflows: SORTED,
    };
    expect(
      current(coverage, costCoverageUrl(REPO, PR, coverage), coverageEcho)
    ).toBe(coverage);
    expect(
      current(coverage, costCoverageUrl(REPO, [], coverage), coverageEcho)
    ).toBeUndefined();

    // The facts read any trend of the page's repository and scope, whatever
    // its length (the page's rule): a scoped trend for the scope, never for
    // every workflow, nor every workflow's for the scope.
    const facts = (t: CostTrend, w: readonly string[]) =>
      costTrendDaysUrl(t.repo, t.workflows, 0) === costTrendDaysUrl(REPO, w, 0);
    expect(facts(SCOPED, PR)).toBe(true);
    expect(facts(SCOPED, [])).toBe(false);
    expect(facts(ALL, PR)).toBe(false);
  });

  // Skipped: names() in lib/tests/cost/query.ts drops duplicates before
  // lowercasing, so Pull and pull both stay; the requests ask pull twice and
  // the server echoes it once (canonicalValues), so no scoped answer is ever
  // current and the page stays dimmed. Unskip once the scope is deduplicated
  // after lowercasing.
  test("a scope written in two cases (?workflow=Pull&workflow=pull) asks once and its answer counts", () => {
    const q = resolveCostQuery({ workflow: ["Pull", "pull", "trunk"] });
    expect(q.workflows).toEqual(["pull", "trunk"]);
    const echoed = { ...SCOPED, workflows: SORTED };
    expect(
      current(
        echoed,
        costTrendDaysUrl(REPO, q.workflows, echoed.periods.length),
        trendEcho
      )
    ).toBe(echoed);
  });
});

describe("switching the scope keeps A/B", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  function stubRouter(query: Record<string, string | string[]>) {
    return {
      pathname: "/tests/[organization]/[repo]/cost",
      query: { organization: "pytorch", repo: "pytorch", ...query },
      push: jest.fn(() => Promise.resolve(true)),
      replace: jest.fn(() => Promise.resolve(true)),
    };
  }
  const lastQuery = (fn: jest.Mock) =>
    (
      fn.mock.calls[fn.mock.calls.length - 1] as unknown as [{ query: object }]
    )[0].query as Record<string, unknown>;

  test("a new scope pushes one history entry and keeps A/B, the trail and the units; dropping it too", async () => {
    const kept = {
      a: "2026-11-05..2026-11-11",
      b: "2026-11-12..2026-11-18",
      trail: "o:inductor",
      unit: "usd",
      per: "commit",
    };
    const router = stubRouter(kept);
    const write = costUrlWriter(router as unknown as CostRouter);
    write({ workflows: PR }, "push");
    await tick();
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
    const scoped = lastQuery(router.push);
    expect(scoped).toMatchObject({ ...kept, workflow: PR });
    // Read back: the same A/B and trail, under the scope.
    const back = resolveCostQuery(scoped as never);
    expect(back.workflows).toEqual(PR);
    expect([back.trends.a, back.trends.b]).toEqual([A, B]);
    expect(back.drill.trail).toEqual([IND]);
    // Back to every workflow: the scope leaves, A/B stay.
    router.query = scoped as typeof router.query;
    write({ workflows: [] }, "push");
    await tick();
    const all = lastQuery(router.push);
    expect(all).toMatchObject(kept);
    expect(all.workflow).toBeUndefined();
  });

  test("a relative preset stays relative across a scope switch", async () => {
    const router = stubRouter({ cmp: "7v7" });
    const write = costUrlWriter(router as unknown as CostRouter);
    write({ workflows: ["pull"] }, "push");
    await tick();
    expect(lastQuery(router.push)).toMatchObject({
      cmp: "7v7",
      workflow: ["pull"],
    });
    expect(lastQuery(router.push).a).toBeUndefined();
  });

  test("A/B resolve the same against the scope's answer; only the requests' workflows change", () => {
    const all = trendContext(ALL);
    const scoped = trendContext(SCOPED);
    expect(scoped).toEqual(all);
    const queries: TrendsQuery[] = [
      QUERY,
      { ...QUERY, cmp: "7v7" },
      { ...QUERY, a: { from: "2026-10-27", to: "2026-10-29" }, b: null },
      {
        ...QUERY,
        a: { from: "2026-10-26", to: "2026-10-28" },
        b: { from: "2026-11-02", to: "2026-11-04" },
      },
      // A on B: A moves to the bars just before B.
      {
        ...QUERY,
        a: { from: "2026-11-03", to: "2026-11-04" },
        b: { from: "2026-11-03", to: "2026-11-04" },
      },
      { ...QUERY, rollup: "week" as Rollup },
    ];
    for (const q of queries) {
      const c = resolveCompare(q, scoped)!;
      expect(c).toEqual(resolveCompare(q, all));
      expect(sameRange(c.a, c.b)).toBe(false);
      // The drill's requests for that A/B: the scope's workflows added,
      // nothing else.
      const url = costScopeUrl(REPO, PR, c.a, c.b, [IND], "m");
      expect(withoutWorkflows(url)).toBe(
        costScopeUrl(REPO, [], c.a, c.b, [IND], "m")
      );
    }
    expect(resolveCompare(queries[4], scoped)).toMatchObject({
      a: { from: "2026-11-01", to: "2026-11-02" },
      b: { from: "2026-11-03", to: "2026-11-04" },
    });
  });

  test("a scope with fewer days: its presets follow its own days, and A still never equals B", () => {
    // The scope ran nothing on Nov 3 (yesterday's yesterday).
    const gone = "2026-11-03";
    const p = SCOPED.periods.indexOf(gone);
    const d = SCOPED.daily.days.indexOf(gone);
    const sparse: CostTrend = {
      ...SCOPED,
      cells: SCOPED.cells.filter((c) => c[0] !== p),
      daily: {
        ...SCOPED.daily,
        days: SCOPED.daily.days.filter((x) => x !== gone),
        pushes: SCOPED.daily.pushes.filter((_, i) => i !== d),
        cells: SCOPED.daily.cells
          .filter((c) => c[0] !== d)
          .map((c) => (c[0] > d ? [c[0] - 1, c[1], c[2], c[3]] : c)) as never,
      },
    };
    const ctx = trendContext(sparse);
    const dod = comparePresets(ctx).find((x) => x.id === "dod")!;
    expect(dod.available).toBe(false);
    expect(dod.title).toBe("Needs Nov 3 – Nov 4; not enough data yet");
    // Every workflow's answer still offers it.
    expect(
      comparePresets(trendContext(ALL)).find((x) => x.id === "dod")!.available
    ).toBe(true);
    // The default falls back to the scope's last two days with data.
    expect(resolveCompare(QUERY, ctx)).toEqual({
      rollup: "day",
      a: { from: "2026-11-02", to: "2026-11-02" },
      b: { from: "2026-11-04", to: "2026-11-04" },
      preset: null,
    });
    // A on B still moves A one bar back, data or not.
    const same = { from: "2026-11-04", to: "2026-11-04" };
    expect(resolveCompare({ ...QUERY, a: same, b: same }, ctx)).toMatchObject({
      a: { from: gone, to: gone },
      b: same,
    });
  });
});

// ── The Trends panel ──
function panelProps(
  answer: CostTrend,
  workflowScope: string | null,
  patch: Partial<TrendsPanelProps> = {}
): TrendsPanelProps {
  const ctx = trendContext(answer);
  const q = patch.query ?? QUERY;
  return {
    answer,
    context: ctx,
    loading: false,
    query: q,
    compare: resolveCompare(q, ctx),
    onQueryChange: jest.fn(),
    pricer: null,
    runnerHours: undefined,
    scope: ROOT_BARS,
    series: undefined,
    seriesLoading: false,
    workflowScope,
    slots: {},
    ...patch,
  };
}

// A node with a box: 960 px wide, so 42 bars of (960 − 64) / 42 px.
const nodeMock = (element: { props: Record<string, unknown> }) => ({
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 300 }),
  focus: () => {},
  setPointerCapture: () => {},
  getAttribute: (name: string) => element.props[name] ?? null,
  setAttribute: () => {},
  removeAttribute: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  style: {},
});
const SLOT = (960 - 64) / 42;
const barX = (i: number) => 56 + (i + 0.5) * SLOT;
const pointer = (x: number) => ({
  button: 0,
  clientX: x,
  clientY: 120,
  pointerId: 1,
  pointerType: "mouse",
  shiftKey: false,
  preventDefault: () => {},
});
const key = (k: string) => ({
  key: k,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  target: {},
  defaultPrevented: false,
  preventDefault: jest.fn(),
  stopPropagation: jest.fn(),
});
const textOf = (n: ReactTestInstance): string =>
  n.children.map((c) => (typeof c === "string" ? c : textOf(c))).join("");

describe("the Trends panel with a scope", () => {
  test("SSR: the band names the scope; the pick and quick rows match every workflow's, the figures are the scope's", () => {
    const all = renderToStaticMarkup(
      <TrendsPanel {...panelProps(ALL, null)} />
    );
    const html = renderToStaticMarkup(
      <TrendsPanel {...panelProps(SCOPED, "PR Critical Path")} />
    );
    const w = words(html);
    expect(w).toContain("Trends · PR Critical Path Day Week Month");
    expect(w).not.toContain("all workflows");
    expect(words(all)).toContain("Trends · all workflows");
    const pick = "Pick A Nov 3 · 1 day B Nov 4 · 1 day";
    expect(w).toContain(pick);
    expect(words(all)).toContain(pick);
    const disabled = (m: string) =>
      [...m.matchAll(/aria-disabled="true"[^>]*>([^<]+)</g)].map((x) => x[1]);
    expect(disabled(html)).toEqual(disabled(all));
    // The live line: B's figure, half every workflow's.
    const figure = (m: string) =>
      Number(/B: Nov 4, 1 day, ([\d.]+) h a day/.exec(words(m))?.[1]);
    expect(figure(all)).toBeGreaterThan(10);
    expect(Math.abs(figure(html) - figure(all) / 2)).toBeLessThanOrEqual(1);
  });

  test("gestures write the A/B patches every workflow's panel writes, never the scope; A never lands on B", () => {
    const run = (answer: CostTrend, scope: string | null) => {
      const p = panelProps(answer, scope);
      let r!: ReturnType<typeof create>;
      act(() => {
        r = create(<TrendsPanel {...p} />, { createNodeMock: nodeMock });
      });
      const svg = () =>
        r.root.find(
          (n) => n.type === "svg" && n.props.onPointerDown !== undefined
        );
      const group = () =>
        r.root.find(
          (n) => typeof n.type === "string" && n.props.role === "group"
        );
      const chip = (label: string) =>
        r.root.find(
          (n) =>
            typeof n.type === "string" &&
            n.props["aria-pressed"] !== undefined &&
            textOf(n) === label
        );
      const calls = () =>
        (p.onQueryChange as jest.Mock).mock.calls.map((c) => c[0]);
      // Bar 30 is Oct 24, bar 40 Nov 3 (A, by the default day over day).
      act(() => svg().props.onPointerDown(pointer(barX(30))));
      act(() => svg().props.onPointerUp(pointer(barX(30))));
      const placed = calls().length;
      // B (armed) on A's bar: nothing.
      act(() => svg().props.onPointerDown(pointer(barX(40))));
      act(() => svg().props.onPointerUp(pointer(barX(40))));
      const blocked = calls().length - placed;
      act(() => group().props.onKeyDown(key("a")));
      act(() => group().props.onKeyDown(key("ArrowLeft")));
      act(() => chip("Last 7 vs prior 7").props.onClick({}));
      act(() => r.unmount());
      return { patches: calls(), blocked };
    };
    const scoped = run(SCOPED, "PR Critical Path");
    expect(scoped).toEqual(run(ALL, null));
    expect(scoped.blocked).toBe(0);
    expect(scoped.patches).toEqual([
      {
        rollup: "day",
        cmp: null,
        a: { from: "2026-11-03", to: "2026-11-03" },
        b: { from: "2026-10-24", to: "2026-10-24" },
      },
      // A moves left from Nov 3; B stays where the click put it.
      {
        rollup: "day",
        cmp: null,
        a: { from: "2026-11-02", to: "2026-11-02" },
        b: { from: "2026-10-24", to: "2026-10-24" },
      },
      { rollup: "day", cmp: "7v7", a: null, b: null },
    ]);
    for (const patch of scoped.patches) {
      expect(
        Object.keys(patch).every((k) =>
          ["rollup", "cmp", "a", "b", "show"].includes(k)
        )
      ).toBe(true);
    }
  });
});

// ── The drill ──
const DRILL: DrillQuery = {
  trail: [],
  root: "o",
  chg: "h",
  sort: "change",
  more: [],
  tests: false,
  cfg: null,
  cases: null,
  rank: null,
};
const echo = (answer: object, workflows: string[], piece = "week") =>
  ({ ...answer, workflows, piece } as unknown as CostScope);
// The captured answers keyed by the URLs the drill asks, echoing the
// workflows given (as asked, unless a test says otherwise).
function fallback(asked: string[], echoed: string[] = asked) {
  const url = (trail: Pill[], by: CostScope["by"], piece?: "day") =>
    costScopeUrl(REPO, asked, A, B, trail, by, piece);
  return {
    [url([], "o")]: echo(ROOT_SCOPE, echoed),
    [url([], "o", "day")]: echo(ROOT_SCOPE, echoed, "day"),
    [url([IND], "m")]: echo(OWNER, echoed),
    [url([IND, AVX], "f")]: echo(PAIR, echoed),
    [url([IND, AVX, FLEX], "lane")]: echo(FILE, echoed),
  };
}

function Inner(props: {
  workflows: string[];
  query: DrillQuery;
  unit: Unit;
  pricer: Pricer | null;
  part: (_d: DrillModel) => ReactNode;
}) {
  const drill = useDrill({
    repo: REPO,
    workflows: props.workflows,
    compare: { rollup: "day", a: A, b: B, preset: null },
    query: props.query,
    onQueryChange: () => {},
    per: "day",
    rollup: "day",
    unit: props.unit,
    pricer: props.pricer,
    runnerHours: undefined,
  });
  return <>{props.part(drill)}</>;
}
function drillOf(
  workflows: string[],
  answers: Record<string, unknown>,
  patch: Partial<DrillQuery> = {},
  pricing: { unit?: Unit; pricer?: Pricer | null } = {}
): { model: DrillModel; html: string } {
  let model: DrillModel | null = null;
  const html = renderToStaticMarkup(
    <SWRConfig value={{ provider: () => new Map(), fallback: answers }}>
      <Inner
        workflows={workflows}
        query={{ ...DRILL, ...patch }}
        unit={pricing.unit ?? "hours"}
        pricer={pricing.pricer ?? null}
        part={(d) => {
          model = d;
          return (
            <>
              <ScopeTrail drill={d} />
              <ScopeHead drill={d} />
              <DrillTable drill={d} />
            </>
          );
        }}
      />
    </SWRConfig>
  );
  return { model: model as unknown as DrillModel, html };
}

describe("the drill with a scope", () => {
  test("every /scope it asks lists the scope sorted; answers echoing it are current and draw as every workflow's do", () => {
    for (const trail of [[], [IND], [IND, AVX], [IND, AVX, FLEX]]) {
      const scoped = drillOf(PR, fallback(SORTED), { trail });
      const all = drillOf([], fallback([]), { trail });
      const urls = [scoped.model.canvas, ...scoped.model.levels];
      expect(urls.length).toBe(trail.length + 1);
      for (const level of urls) {
        expect(level.url).toContain("&workflow=pull&workflow=trunk");
        expect(level.current).toBeDefined();
        expect([level.stale, level.loading]).toEqual([false, false]);
      }
      expect(urls.map((l) => withoutWorkflows(l.url!))).toEqual(
        [all.model.canvas, ...all.model.levels].map((l) => l.url)
      );
      // The same answers' numbers: the same words.
      expect(words(scoped.html)).toBe(words(all.html));
    }
  });

  test("in $, day pieces under the scope: both piece=day and the workflows", () => {
    const pricer = makePricer(
      parseRatesFiles([
        {
          name: "rates_FAKE_weekly.json",
          text: readFileSync(join(__dirname, "rates_FAKE_weekly.json"), "utf8"),
        },
      ]),
      "2026-11-19"
    );
    const { model } = drillOf(
      PR,
      fallback(SORTED),
      {},
      { unit: "usd", pricer }
    );
    expect(model.canvas.url).toBe(
      costScopeUrl(REPO, SORTED, A, B, [], "o", "day")
    );
    expect(model.canvas.url).toMatch(
      /&piece=day&workflow=pull&workflow=trunk$/
    );
    expect(model.canvas.current?.piece).toBe("day");
    expect(model.canvas.view?.unit).toBe("usd");
  });

  test("a kept answer of another scope is never current: drawn dimmed, never acted on", () => {
    // Every workflow's answers under the scope's URLs, as keepPreviousData
    // hands them back while the scope's load.
    const { model, html } = drillOf(PR, fallback(SORTED, []), {
      trail: [IND],
    });
    for (const level of [model.canvas, ...model.levels]) {
      expect(level.current).toBeUndefined();
      expect([level.stale, level.loading]).toEqual([true, true]);
    }
    expect(model.head.stale).toBe(true);
    expect(model.head.sentence).toBeNull();
    expect(html).toContain("opacity");
  });

  test("the cases are every workflow's: one /cases URL with or without a scope", () => {
    const want = costCasesUrl(REPO, FLEX.value, AVX.value, A, B);
    for (const [w, echoed] of [
      [PR, SORTED],
      [[], []],
    ]) {
      const { model } = drillOf(w, fallback(echoed), {
        trail: [IND, AVX, FLEX],
        tests: true,
      });
      expect(model.cases.url).toBe(want);
    }
  });
});

// ── The headline facts ──
describe("the headline facts with a scope", () => {
  // Oct 22 – Nov 18, every day whole: every workflow runs 1,000 h a day on
  // one label (100 on pushes to main), the PR Critical Path 600 (60), 50
  // pushes a day either way.
  const LABEL = "mt-l-x86iavx512-16-128";
  const DAYS: Day[] = Array.from({ length: 28 }, (_, i) =>
    addDays("2026-10-22", i)
  );
  const trendOf = (workflows: string[], h: number): CostTrend => ({
    repo: REPO,
    rollup: "day",
    workflows,
    start: DAYS[0],
    end: "2026-11-19",
    periods: DAYS,
    owners: ["inductor"],
    labels: [LABEL],
    cells: DAYS.map((_, i) => [i, 0, 0, h, h / 10]),
    daily: {
      start: "2026-01-01",
      days: DAYS,
      filling: [],
      pushes: DAYS.map(() => 50),
      cells: DAYS.map((_, i) => [i, 0, h, h / 10]),
    },
    query_duration_ms: 1,
  });
  const all = trendOf([], 1000);
  const scoped = trendOf(SORTED, 600);

  test("hours: the scope's own cells, named by the scope", () => {
    expect(pageFacts(scoped, "hours", null).perDay.value).toBe(600);
    expect(pageFacts(scoped, "hours", null).perCommit.value).toBeCloseTo(1.2);
    expect(pageFacts(all, "hours", null).perDay.value).toBe(1000);
    const html = renderToStaticMarkup(
      <PageFacts
        trend={scoped}
        scope="PR Critical Path"
        unit="hours"
        pricer={null}
      />
    );
    expect(words(html)).toContain(
      "Across PR Critical Path Annualized 219K runner-hours a year Per day 600 runner-hours"
    );
  });

  test("$ with the FAKE weekly rates: each day at its own week's rate, the borrowed days ≈", () => {
    const json = JSON.parse(
      readFileSync(join(__dirname, "rates_FAKE_weekly.json"), "utf8")
    );
    const pricer = makePricer(
      parseRatesFiles([
        { name: "rates_FAKE_weekly.json", text: JSON.stringify(json) },
      ]),
      "2026-11-19"
    );
    // Oct 22–25 in the first week, …, Nov 16–18 borrowing the last.
    const rateOn = (day: Day) => {
      const p =
        json.periods.find(
          (x: { valid_from: Day; valid_through: Day }) =>
            x.valid_from <= day && day <= x.valid_through
        ) ?? json.periods[json.periods.length - 1];
      return p.rates[LABEL] as number;
    };
    const want = DAYS.reduce((t, d) => t + 600 * rateOn(d), 0) / DAYS.length;
    const f = pageFacts(scoped, "usd", pricer);
    expect(f.perDay.value).toBeCloseTo(want, 6);
    expect(f.perDay.approx).toBe(true);
    expect(f.perDay.unpriced).toBe(0);
    expect(f.perCommit.value).toBeCloseTo(want / 10 / 50, 9);
    // The scope's $ is 60% of every workflow's, day by day.
    expect(
      f.perDay.value! / pageFacts(all, "usd", pricer).perDay.value!
    ).toBeCloseTo(0.6, 9);
  });
});

// ── The coverage banner ──
describe("the coverage banner with a scope", () => {
  const END = "2026-11-20";
  const shown: DayRange = { from: B.from, to: B.to };
  beforeEach(() => {
    mockAsked.length = 0;
    mockCoverageEcho = null;
  });
  const banner = (unit: Unit = "hours", pricer: Pricer | null = null) =>
    renderToStaticMarkup(
      <CoverageBanner
        repo={REPO}
        workflows={PR}
        b={B}
        shown={shown}
        end={END}
        unit={unit}
        pricer={pricer}
      />
    );

  test("asks /coverage for the scope sorted and /coverage/jobs without it; the test jobs outside the scope draw grey", () => {
    const html = banner();
    expect(mockAsked).toContain(costCoverageUrl(REPO, SORTED, B));
    expect(mockAsked).toContain(costCoverageJobsUrl(REPO, jobsWindow(END)));
    for (const url of mockAsked.filter((u) => u.includes("/coverage/jobs"))) {
      expect(url).not.toContain("workflow=");
    }
    expect(html).toContain('data-part="outside_view"');
    expect(html).toContain("data-bracket");
  });

  test("an answer for another scope isn't sliced: no strip until the scope's arrives", () => {
    mockCoverageEcho = [];
    const html = banner();
    expect(html).not.toContain("data-bracket");
    expect(html).not.toContain('data-part="outside_view"');
  });

  test("in $ with FAKE totals: the scope's grey part priced, the ghost beside the bill", () => {
    const pricer = makePricer(
      parseRatesFiles([
        {
          name: "rates_FAKE_weekly.json",
          text: readFileSync(join(__dirname, "rates_FAKE_weekly.json"), "utf8"),
        },
      ]),
      END
    );
    const html = banner("usd", pricer);
    expect(html).toContain('data-part="outside_view"');
    expect(html).toContain('data-part="outside_jobs"');
    expect(words(html)).toContain("total AWS spend Nov 12 – 18 (B)");
  });
});
