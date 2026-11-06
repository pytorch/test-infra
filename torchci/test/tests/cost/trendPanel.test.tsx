// The trend panel drawn from the example answers and rates beside this file
// and read as words: its cards and owner rows say what trend.ts works out
// (trend.test.ts), in runner-hours until a rates file is added; what changed
// says what changes.ts works out (changes.test.ts); its chart draws a bar a
// period with a budget line each; dragging across the bars sets B, and with
// Shift A; and a row's click highlights its owners.

import TrendChanges from "components/tests/cost/TrendChanges";
import TrendChart from "components/tests/cost/TrendChart";
import TrendPanel from "components/tests/cost/TrendPanel";
import TrendTable from "components/tests/cost/TrendTable";
import {
  type CostChanges,
  CostChangesSchema,
  CostTrendSchema,
} from "lib/api/tests/cost/types";
import { parseRates, type RatesFile } from "lib/tests/cost/rates";
import { prepareRunnerHours } from "lib/tests/cost/runnerHours";
import {
  DEFAULT_TREND_SORT,
  type PeriodRange,
  prepareTrend,
  trendRows,
  trendSeries,
} from "lib/tests/cost/trend";
import { useCostChanges } from "lib/tests/cost/useCost";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import ANSWER_JSON from "./answer.json";
import CHANGES_JSON from "./changes.json";
import RATES_JSON from "./rates.json";
import TREND_JSON from "./trend.json";

// What changed comes from its own endpoint, through this hook: each test
// says what it answers.
jest.mock("lib/tests/cost/useCost", () => ({ useCostChanges: jest.fn() }));
const useChanges = useCostChanges as jest.MockedFunction<typeof useCostChanges>;
function answering(changes: CostChanges | undefined) {
  useChanges.mockReturnValue({
    changes,
    error: undefined,
    isLoading: false,
    retry: async () => {},
  });
}

const answer = CostTrendSchema.parse(TREND_JSON);
const changes = CostChangesSchema.parse(CHANGES_JSON);
// The same periods and hours for every owner.
const everyone: CostChanges = { ...changes, owners: [] };
const prepared = prepareTrend(answer);
const rates = parseRates(JSON.stringify(RATES_JSON), "rates.json");
const A = { from: 0, to: 6 };
const B = { from: 7, to: 13 };
const noop = () => {};
// The cost answer beside this file names the fixture's runner labels'
// machines: NVIDIA L4 and NVIDIA A10G.
const runnerHours = prepareRunnerHours(ANSWER_JSON as never);

function unstyled(markup: string): string {
  return markup.replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, "");
}

function words(markup: string): string {
  return unstyled(markup)
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// A test renderer's tree as words, as words() reads markup.
function textOf(node: unknown): string {
  const parts: string[] = [];
  const walk = (n: unknown) => {
    if (n === null || n === undefined) return;
    if (typeof n === "string") parts.push(n);
    else if (Array.isArray(n)) n.forEach(walk);
    else if (typeof n === "object" && "children" in (n as object)) {
      walk((n as { children: unknown }).children);
    }
  };
  walk(node);
  return parts.join("").replace(/\s+/g, " ").trim();
}

function panel(
  r: RatesFile | null,
  highlighted: string[] = [],
  scope: string | null = null,
  trend = answer
): string {
  return words(
    renderToStaticMarkup(
      <TrendPanel
        answer={trend}
        loading={false}
        rollup="day"
        onRollupChange={noop}
        rates={r}
        scope={scope}
        highlighted={highlighted}
        onToggleOwners={noop}
        runnerHours={runnerHours}
      />
    )
  );
}

describe("TrendPanel", () => {
  beforeEach(() => answering(undefined));

  test("in $, B against A per day, its $ per runner-hour, the year to date against the budget and B's pace a year", () => {
    const text = panel(rates);
    expect(text).toContain("A Oct 22 – Oct 28 ✕ · B Oct 29 – Nov 4");
    // $27.75 a day against $23.50; $194.25 in B, 35 of its 266 h unpriced.
    expect(text).toContain(
      "$ per day in B $28 ▲ +18% vs A ($24) $194 over Oct 29 – Nov 4 · 7 days with data · 13% of hours unpriced"
    );
    expect(text).toContain(
      "$ per runner-hour $0.841/h ▲ vs A ($0.734/h): pricier machines"
    );
    // $368.75 against $375 for the 15 days with data; $10,128.75 a year
    // against $9,125.
    expect(text).toContain(
      "Year to date vs budget, all owners $369 of $375 98% of the budget for the 15 days with data since 2026-03-01"
    );
    expect(text).toContain(
      "B's pace a year $10.1K ▲ over the $9.1K budget by 11%"
    );
    expect(text).toContain("dashed lines are the budget");
  });

  test("the owners table in $: per day, change, per commit, a Trend column that says what it plots, and each budget", () => {
    const text = panel(rates);
    expect(text).toContain(
      "Owner Share of B A / day B / day Change % Per commit A → B Trend ($/day, daily) vs budget"
    );
    // Per commit, $0.65 to $1.0625, and inductor's $0.375 to $0.625, to
    // the cent under $10.
    expect(text).toContain(
      "All test hours 100% $24 $28 ▲ +$4.25 ▲ +18% $0.65 → $1.06 ▲ Over 11%"
    );
    expect(text).toContain(
      "inductor 54% $13 $15 ▲ +$2.50 ▲ +20% $0.38 → $0.63 ▲ Over 37%"
    );
    expect(text).toContain(
      "dynamo 29% $10 $8 ▼ −$2 ▼ −20% $0.25 → $0.25 ✓ Under 42%"
    );
    expect(text).toContain("distributed 14% $0 $3.75 ▲ +$3.75 new $0 → $0.16");
    expect(text).toContain("No test reports 0% $0 $0 — — $0 → $0");
  });

  test("without a rates file, runner-hours, $ off, and no budget", () => {
    const text = panel(null);
    expect(text).toContain(
      "Runner-hours per day in B 38 h ▲ +3% vs A (37 h) 266 h over Oct 29 – Nov 4 · 7 days with data"
    );
    expect(text).toContain("All test hours 100% 37 h 38 h ▲ +1 h ▲ +3%");
    expect(text).not.toMatch(/\$\d|Year to date|pace a year|vs budget/);
  });

  test("the page's highlighted owners are the cards' and are ticked; the year to date stays every owner's", () => {
    const text = panel(rates, ["inductor"], "pull + trunk");
    expect(text).toContain("Trends and budget · pull + trunk");
    expect(text).toContain("inductor: $ per day in B $15 ▲ +20% vs A ($13)");
    expect(text).toContain("inductor: $ per runner-hour $1.25/h same as A");
    expect(text).toContain("Year to date vs budget, all owners $369 of $375");
    // $15 a day is $5,475 a year against inductor's $4,000.
    expect(text).toContain(
      "inductor: B's pace a year $5.5K ▲ over the $4K budget by 37%"
    );
    expect(text).toContain("✓ inductor 54%");
  });

  test("a rates file without a budget says where one goes", () => {
    const noBudget = parseRates(
      JSON.stringify({ rates: RATES_JSON.rates }),
      "plain.json"
    );
    expect(panel(noBudget)).toContain(
      `Year to date vs budget No budget Add "budget": {"annual": $} to plain.json's wrapped form`
    );
  });

  test("asks what changed for the periods compared and the highlighted owners, in the page's scope", () => {
    panel(null, ["inductor"]);
    expect(useChanges).toHaveBeenLastCalledWith(
      "/api/tests/cost/changes?repo=pytorch%2Fpytorch&a=2026-10-22..2026-10-28&b=2026-10-29..2026-11-04&owner=inductor"
    );
    panel(null);
    expect(useChanges).toHaveBeenLastCalledWith(
      "/api/tests/cost/changes?repo=pytorch%2Fpytorch&a=2026-10-22..2026-10-28&b=2026-10-29..2026-11-04"
    );
    expect(panel(null)).toContain(
      "What changed · every owner · per day · A → B Per day Per commit Comparing A and B…"
    );
  });

  test("for a highlighted owner, per push to main, and what changed by machine", () => {
    answering(changes);
    const text = panel(rates, ["inductor"]);
    // $35 of push:main L4 hours over 56 pushes, $0.625 a push, against
    // $26.25 over 70, $0.375: whole dollars on the page; 35 of inductor's
    // 112 h in B are pushes to main.
    expect(text).toContain(
      "inductor: $ per commit in B $0.63 ▲ +67% vs A ($0.38) What a push to main costs; main runs every test. 8 pushes a day ran 31% of inductor's runner-hours in B"
    );
    expect(text).toContain(
      "What changed · inductor · per day · A → B Per day Per commit"
    );
    expect(text).toContain(
      "$13 a day in A (Oct 22 – Oct 28), $15 in B (Oct 29 – Nov 4): ▲ +$2.50 a day (+20%) = ▲ +$2.50 from more runner-hours on the same mix of machines."
    );
    expect(text).toContain(
      "Pushes to main: 10 a day in A, 8 in B · $0.38 a commit → $0.63 (+67%)."
    );
    // rates.json prices L4 at $1.25 an hour and not A10G.
    expect(text).toContain(
      "Machine Share of B A / day B / day Change % All machines 100% $13 $15 ▲ +$2.50 ▲ +20% ▸ NVIDIA L4 100% $13 $15 ▲ +$2.50 ▲ +20% ▸ NVIDIA A10G — — — — unpriced"
    );
    expect(text).toContain("Per day with data: 7 in A, 7 in B.");
  });

  test("an answer for other periods or owners is dimmed and drives no card", () => {
    // The answer shown last, inductor's, while every owner's loads.
    answering(changes);
    const markup = renderToStaticMarkup(
      <TrendPanel
        answer={answer}
        loading={false}
        rollup="day"
        onRollupChange={noop}
        rates={null}
        scope={null}
        highlighted={[]}
        onToggleOwners={noop}
      />
    );
    expect(words(markup)).not.toContain("Comparing A and B");
    expect(words(markup)).toContain("What changed · inductor");
    expect(markup).toContain("opacity:0.6");
  });

  test("a day still filling, and a weekend mix A and B do not share, are said", () => {
    const filling = CostTrendSchema.parse({
      ...TREND_JSON,
      daily: { ...TREND_JSON.daily, filling: ["2026-11-04"] },
    });
    // No preset while Nov 4 fills: Nov 3 against Nov 2, both Mondays and
    // Tuesdays, no warning.
    const text = panel(null, [], null, filling);
    expect(text).toContain("A Nov 2 ✕ · B Nov 3");
    expect(text).not.toContain("still filling");
    expect(text).not.toContain("weekend");
    // Dragged to Thursday Oct 22 – Saturday Oct 24 against Wednesday Nov 4.
    let renderer: ReturnType<typeof create> | undefined;
    act(() => {
      renderer = create(
        <TrendPanel
          answer={filling}
          loading={false}
          rollup="day"
          onRollupChange={noop}
          rates={null}
          scope={null}
          highlighted={[]}
          onToggleOwners={noop}
        />,
        {
          // 14 bars across 140 px: 10 px each; enough of an element for
          // the panel's other refs.
          createNodeMock: () => ({
            getBoundingClientRect: () => ({ left: 0, width: 140 }),
            getAttribute: () => null,
            setAttribute: noop,
            removeAttribute: noop,
            addEventListener: noop,
            removeEventListener: noop,
            style: {},
          }),
        }
      );
    });
    const plot = () =>
      renderer!.root.find(
        (n) => typeof n.type === "string" && n.props.role === "group"
      );
    const pointer = (clientX: number, shiftKey = false) => ({
      button: 0,
      clientX,
      shiftKey,
      pointerId: 1,
      currentTarget: { setPointerCapture: noop },
    });
    act(() => plot().props.onPointerDown(pointer(5, true)));
    act(() => plot().props.onPointerMove(pointer(25, true)));
    act(() => plot().props.onPointerUp(pointer(25, true)));
    act(() => plot().props.onPointerDown(pointer(135)));
    act(() => plot().props.onPointerUp(pointer(135)));
    const dragged = textOf(renderer!.toJSON());
    expect(dragged).toContain("A Oct 22 – Oct 24 ✕ · B Nov 4");
    expect(dragged).toContain(
      "⚠ Nov 4 is still filling: jobs that started then are still running, so it reads low until the rollup computes it again after 03:00 UTC."
    );
    expect(dragged).toContain(
      "⚠ A has 1 of 3 days on a weekend, B 0 of 1: weekends run far fewer jobs, so compare the same weekdays, whole weeks, or per commit."
    );
    act(() => renderer!.unmount());
  });

  test("Week and Month wait for two whole weeks or months of data; Day is always there", () => {
    const markup = renderToStaticMarkup(
      <TrendPanel
        answer={answer}
        loading={false}
        rollup="day"
        onRollupChange={noop}
        rates={null}
        scope={null}
        highlighted={[]}
        onToggleOwners={noop}
      />
    );
    expect(markup).toMatch(/disabled=""[^>]*>Week</);
    expect(markup).toMatch(/disabled=""[^>]*>Month</);
    expect(markup).not.toMatch(/disabled=""[^>]*>Day</);
    // Days with data from Oct 19 through Nov 4: the weeks of Oct 19 and
    // Oct 26 are whole, October is not.
    const days: string[] = [];
    for (let d = 19; d <= 35; d++) {
      days.push(new Date(Date.UTC(2026, 9, d)).toISOString().slice(0, 10));
    }
    const weeks = renderToStaticMarkup(
      <TrendPanel
        answer={{
          ...answer,
          daily: {
            ...answer.daily,
            days,
            pushes: days.map(() => 8),
            cells: [],
          },
        }}
        loading={false}
        rollup="day"
        onRollupChange={noop}
        rates={null}
        scope={null}
        highlighted={[]}
        onToggleOwners={noop}
      />
    );
    expect(weeks).not.toMatch(/disabled=""[^>]*>Week</);
    expect(weeks).toMatch(/disabled=""[^>]*>Month</);
  });

  test("an answer without data says so", () => {
    const empty = renderToStaticMarkup(
      <TrendPanel
        answer={{
          ...answer,
          cells: [],
          daily: {
            start: "2026-01-01",
            days: [],
            filling: [],
            pushes: [],
            cells: [],
          },
        }}
        loading={false}
        rollup="day"
        onRollupChange={noop}
        rates={null}
        scope={null}
        highlighted={[]}
        onToggleOwners={noop}
      />
    );
    expect(words(empty)).toContain(
      "The rollup holds no runner-hours in these periods yet."
    );
  });
});

describe("TrendChanges", () => {
  const element = (
    c: CostChanges | undefined,
    r: RatesFile | null = null,
    per: "day" | "commit" = "day",
    onPerChange: (_per: "day" | "commit") => void = noop
  ) => (
    <TrendChanges
      changes={c}
      loading={false}
      error={undefined}
      onRetry={noop}
      rates={r}
      per={per}
      onPerChange={onPerChange}
      prepared={runnerHours}
    />
  );
  const changesText = (
    c: CostChanges,
    r: RatesFile | null = null,
    per: "day" | "commit" = "day"
  ) => words(renderToStaticMarkup(element(c, r, per)));

  test("in runner-hours, the change, then every machine and each machine's share of B, A and B per day, change and %", () => {
    const text = changesText(changes);
    expect(text).toContain(
      "14 h a day in A (Oct 22 – Oct 28), 16 h in B (Oct 29 – Nov 4): ▲ +2 h a day (+14%) ."
    );
    expect(text).toContain(
      "Pushes to main: 10 a day in A, 8 in B · 0.4 h a commit → 0.6 h (+56%)."
    );
    expect(text).toContain(
      "Machine Share of B A / day B / day Change % All machines 100% 14 h 16 h ▲ +2 h ▲ +14% ▸ NVIDIA L4 75% 10 h 12 h ▲ +2 h ▲ +20% ▸ NVIDIA A10G 25% 4 h 4 h — —"
    );
    expect(text).toContain(
      "Bars: B; the tick: A. Click a machine to list its runners. Per day with data: 7 in A, 7 in B."
    );
  });

  test("per commit: each machine's push:main runner-hours over the pushes to main", () => {
    // L4: 21 push:main hours over 70 pushes, then 28 over 56; A10G: 7 over
    // 70, then 7 over 56.
    const text = changesText(changes, null, "commit");
    expect(text).toContain("What changed · inductor · per commit · A → B");
    expect(text).toContain(
      "Machine Share of B A / commit B / commit Change % All machines 100% 0.4 h 0.6 h ▲ +0.2 h ▲ +56% ▸ NVIDIA L4 80% 0.3 h 0.5 h ▲ +0.2 h ▲ +67% ▸ NVIDIA A10G 20% 0.1 h 0.1 h ▲ +&lt;0.1 h ▲ +25%"
    );
    expect(text).toContain(
      "Per commit is what a push to main costs: main runs every test, with no target determination, so it is a normalized unit cost."
    );
    // Said once, as a warning, per commit only.
    expect(text).toContain(
      "⚠ Pushes to main only: machines they do not run on drop out, and shares are of a main push's cost."
    );
    expect(changesText(changes)).not.toContain("⚠ Pushes to main only");
  });

  test("its keys switch the panel's per; per commit is off without pushes to main", () => {
    const onPerChange = jest.fn();
    let renderer: ReturnType<typeof create> | undefined;
    act(() => {
      renderer = create(element(changes, null, "day", onPerChange));
    });
    const key = (name: string) =>
      renderer!.root.find(
        (n) =>
          typeof n.type === "string" &&
          n.type === "button" &&
          textOf(n.children) === name
      );
    act(() => key("Per commit").props.onClick());
    act(() => key("Per day").props.onClick());
    expect(onPerChange.mock.calls).toEqual([["commit"], ["day"]]);
    act(() => renderer!.unmount());
    const quiet = {
      ...changes,
      days: changes.days.map(([d]) => [d, 0] as [string, number]),
    };
    expect(renderToStaticMarkup(element(quiet))).toMatch(
      /disabled=""[^>]*>Per commit</
    );
    expect(renderToStaticMarkup(element(changes))).not.toMatch(
      /disabled=""[^>]*>Per commit</
    );
  });

  test("for every owner, the same machines", () => {
    const text = changesText(everyone);
    expect(text).toContain("What changed · every owner · per day · A → B");
    expect(text).toContain("▸ NVIDIA L4 75% 10 h 12 h ▲ +2 h ▲ +20%");
  });

  test("a click on a machine lists its runners; again, folds them", () => {
    let renderer: ReturnType<typeof create> | undefined;
    act(() => {
      renderer = create(element(changes));
    });
    // A machine's row, by the title that names it.
    const row = (name: string) =>
      renderer!.root.find(
        (n) =>
          typeof n.type === "string" &&
          n.props.role === "row" &&
          typeof n.props.title === "string" &&
          n.props.title.startsWith(`${name}:`)
      );
    expect(row("NVIDIA L4").props["aria-expanded"]).toBe(false);
    expect(row("NVIDIA L4").props.title).toBe(
      "NVIDIA L4: 10 h in A, 12 h in B a day. List its runners"
    );
    act(() => row("NVIDIA L4").props.onClick());
    let text = textOf(renderer!.toJSON());
    expect(row("NVIDIA L4").props["aria-expanded"]).toBe(true);
    expect(text).toContain("▾NVIDIA L4");
    expect(text).toContain("mt-l-x86aavx2-11-41-l475%10 h12 h▲ +2 h▲ +20%");
    expect(text).not.toContain("mt-l-x86aavx2-11-41-a10g");
    act(() => row("NVIDIA L4").props.onClick());
    text = textOf(renderer!.toJSON());
    expect(text).not.toContain("mt-l-x86aavx2-11-41-l4");
    act(() => renderer!.unmount());
  });

  test("a failure without an answer says so and offers a retry", () => {
    const text = words(
      renderToStaticMarkup(
        <TrendChanges
          changes={undefined}
          loading={false}
          error={new Error("boom")}
          onRetry={noop}
          rates={null}
          per="day"
          onPerChange={noop}
        />
      )
    );
    expect(text).toContain("Could not load what changed");
    expect(text).toContain("Retry");
  });
});

describe("TrendChart", () => {
  const chart = (
    budget: Float64Array | null,
    onRangeChange: (_w: "a" | "b", _r: PeriodRange) => void = noop
  ) => (
    <TrendChart
      prepared={prepared}
      series={trendSeries(prepared, rates, new Set(["inductor"]))}
      highlighting
      budget={budget}
      a={A}
      b={B}
      onRangeChange={onRangeChange}
    />
  );

  test("a bar a period, its tooltip its amount, the highlighted owners' and its budget", () => {
    const markup = renderToStaticMarkup(
      chart(Float64Array.from(prepared.periodData, (d) => (9125 * d) / 365))
    );
    const titles = Array.from(
      unstyled(markup).matchAll(/ title="([^"]*)"/g),
      (m) => m[1]
    );
    expect(titles).toHaveLength(14);
    expect(titles[0]).toBe("Oct 22: $24 · highlighted: $13 · budget: $25");
    expect(titles[13]).toBe("Nov 4: $28 · highlighted: $15 · budget: $25");
    expect(words(markup)).toMatch(/^0 \$10 \$20 \$30 A B Oct 22/);
    expect(unstyled(markup).match(/dashed/g)).toBeNull(); // the lines' style is in the stylesheet
    expect(markup.match(/border-top:2px dashed/g)?.length).toBeGreaterThan(0);
  });

  test("dragging across the bars sets B; with Shift held, A", () => {
    const onRangeChange = jest.fn();
    let renderer: ReturnType<typeof create> | undefined;
    // 14 bars across 140 px: 10 px each.
    act(() => {
      renderer = create(chart(null, onRangeChange), {
        createNodeMock: () => ({
          getBoundingClientRect: () => ({ left: 0, width: 140 }),
        }),
      });
    });
    const plot = () =>
      renderer!.root.find(
        (n) => typeof n.type === "string" && n.props.role === "group"
      );
    const pointer = (clientX: number, shiftKey = false) => ({
      button: 0,
      clientX,
      shiftKey,
      pointerId: 1,
      currentTarget: { setPointerCapture: noop },
    });
    act(() => plot().props.onPointerDown(pointer(45)));
    act(() => plot().props.onPointerMove(pointer(15)));
    act(() => plot().props.onPointerUp(pointer(15)));
    expect(onRangeChange).toHaveBeenLastCalledWith("b", { from: 1, to: 4 });
    act(() => plot().props.onPointerDown(pointer(135, true)));
    act(() => plot().props.onPointerUp(pointer(135, true)));
    expect(onRangeChange).toHaveBeenLastCalledWith("a", { from: 13, to: 13 });
    act(() => renderer!.unmount());
  });
});

describe("TrendTable", () => {
  test("a row's click highlights its owners; the folded row lists them; every owner together is no button", () => {
    const onToggleOwners = jest.fn();
    const onExpand = jest.fn();
    const onSort = jest.fn();
    let renderer: ReturnType<typeof create> | undefined;
    act(() => {
      renderer = create(
        <TrendTable
          rows={trendRows(
            prepared,
            rates,
            A,
            B,
            new Set(),
            DEFAULT_TREND_SORT,
            false,
            1
          )}
          unit="cost"
          per="day"
          rollup="day"
          periodsLabel="Oct 22 – Nov 4"
          highlighted={new Set()}
          aLabel="Oct 22 – Oct 28"
          bLabel="Oct 29 – Nov 4"
          sort={DEFAULT_TREND_SORT}
          onSort={onSort}
          onToggleOwners={onToggleOwners}
          onExpand={onExpand}
        />
      );
    });
    const rows = renderer!.root.findAll(
      (n) => typeof n.type === "string" && n.props.role === "row"
    );
    // The header, then every owner, inductor, 2 more owners and the buckets.
    expect(rows).toHaveLength(6);
    act(() => rows[2].props.onClick());
    expect(onToggleOwners).toHaveBeenLastCalledWith(["inductor"]);
    act(() => rows[3].props.onClick());
    expect(onExpand).toHaveBeenCalled();
    act(() => rows[5].props.onClick());
    expect(onToggleOwners).toHaveBeenLastCalledWith([
      "unattributed:no_test_reports",
    ]);
    expect(rows[1].props["aria-disabled"]).toBe(true);
    // A, B, Change and % sort; B, largest first, is in force.
    const headers = renderer!.root.findAll(
      (n) =>
        typeof n.type === "string" &&
        n.props.role === "columnheader" &&
        n.props["aria-sort"] !== undefined
    );
    expect(
      headers.map((h) => [textOf(h.children), h.props["aria-sort"]])
    ).toEqual([
      ["A / day", "none"],
      ["B / day", "descending"],
      ["Change", "none"],
      ["%", "none"],
    ]);
    expect(headers[1].props.title).toBe(
      "B: Oct 29 – Nov 4. Sort by it, smallest first"
    );
    const sortButton = (h: (typeof headers)[number]) =>
      h.find((n) => typeof n.props.onClick === "function");
    act(() => sortButton(headers[2]).props.onClick());
    act(() => sortButton(headers[1]).props.onClick());
    expect(onSort.mock.calls).toEqual([["delta"], ["b"]]);
    act(() => renderer!.unmount());
  });
});
