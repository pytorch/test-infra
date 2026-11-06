// The trend panel drawn from the example answers and rates beside this file
// and read as words: its cards, B's pace and owner rows say what trend.ts
// works out (trend.test.ts), in runner-hours until a rates file is added;
// what changed says what changes.ts works out (changes.test.ts), its
// machines past the largest few folded; its chart draws a bar a period,
// its caption under it saying only what applies;
// dragging across the bars sets B, and with Shift A; a row's click toggles
// its owners, and the Owner key picks one or steps through them.

import TrendChanges from "components/tests/cost/TrendChanges";
import TrendChart from "components/tests/cost/TrendChart";
import TrendPanel from "components/tests/cost/TrendPanel";
import TrendTable from "components/tests/cost/TrendTable";
import HeaderSelect from "components/tests/HeaderSelect";
import {
  type CostChanges,
  CostChangesSchema,
  type CostTrend,
  CostTrendSchema,
} from "lib/api/tests/cost/types";
import { parseRates, type RatesFile } from "lib/tests/cost/rates";
import {
  NOT_PROBED,
  type PreparedHours,
  prepareRunnerHours,
} from "lib/tests/cost/runnerHours";
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
// The Owner key as its props and its words: its menu is MUI's, whose
// popover listens on a browser's window, which these tests have none of.
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
        onOwnersChange={noop}
        runnerHours={runnerHours}
      />
    )
  );
}

// 14 bars across 140 px: 10 px each; enough of an element for the panel's
// other refs.
const nodeMock = () => ({
  getBoundingClientRect: () => ({ left: 0, width: 140 }),
  getAttribute: () => null,
  setAttribute: noop,
  removeAttribute: noop,
  addEventListener: noop,
  removeEventListener: noop,
  style: {},
});

describe("TrendPanel", () => {
  beforeEach(() => answering(undefined));

  test("in $, B against A per day and per commit, its $ per runner-hour and B's pace projected", () => {
    const text = panel(rates);
    expect(text).toContain("A Oct 22 – Oct 28 ✕ · B Oct 29 – Nov 4");
    // $27.75 a day against $23.50; $194.25 in B, 35 of its 266 h unpriced.
    expect(text).toContain(
      "$ per day in B $28 ▲ +18% vs A ($24) $194 total, Oct 29 – Nov 4 · 13% of hours unpriced"
    );
    // $59.50 of push:main over 56 pushes against $45.50 over 70; 75.25 of
    // B's 266 runner-hours.
    expect(text).toContain(
      "$ per commit in B $1.06 ▲ +63% vs A ($0.65) What one push to main costs, with every test running (no target determination). 8 pushes a day; their jobs are 28% of B's runner-hours."
    );
    expect(text).toContain(
      "$ per runner-hour $0.841/h ▲ vs A ($0.734/h): pricier machines"
    );
    // $27.75 a day is $10,128.75 a year, $844.06 a month.
    expect(text).toContain(
      "$ per runner-hour $0.841/h ▲ vs A ($0.734/h): pricier machines Projected $ per year $10.1K $844 per month at B's daily average · 13% of hours unpriced"
    );
    expect(text).toContain(
      "Each bar is a day's total. Drag across the bars to set B, or Shift-drag to set A. $ per day"
    );
    expect(text).not.toContain("Faded");
  });

  test("the owners table in $: per day, change, per commit, and a Trend column that says what it plots", () => {
    const text = panel(rates);
    expect(text).toContain(
      "Owner Share of B A / day B / day Change % Per commit A → B Daily trend All owners"
    );
    // Per commit, $0.65 to $1.0625, and inductor's $0.375 to $0.625, to
    // the cent under $10.
    expect(text).toContain(
      "All owners 100% $24 $28 ▲ +$4.25 ▲ +18% $0.65 → $1.06 inductor 54% $13 $15 ▲ +$2.50 ▲ +20% $0.38 → $0.63 dynamo 29% $10 $8 ▼ −$2 ▼ −20% $0.25 → $0.25 distributed 14% $0 $3.75 ▲ +$3.75 new $0 → $0.16"
    );
    expect(text).toContain("No test reports 0% $0 $0 — — $0 → $0");
  });

  test("without a rates file, runner-hours, $ off, and B's pace projected in runner-hours", () => {
    const text = panel(null);
    expect(text).toContain(
      "Runner-hours per day in B 38 h ▲ +3% vs A (37 h) 266 h total, Oct 29 – Nov 4"
    );
    // 75.25 h over 56 pushes against 68.25 over 70.
    expect(text).toContain(
      "Runner-hours per commit in B 1.3 h ▲ +38% vs A (1 h) What one push to main costs, with every test running (no target determination). 8 pushes a day; their jobs are 28% of B's runner-hours."
    );
    // 38 h a day is 13,870 h a year, 1,155.8 a month.
    expect(text).toContain(
      "Projected runner-hours per year 13.9K h 1.2K h per month at B's daily average"
    );
    expect(text).toContain("All owners 100% 37 h 38 h ▲ +1 h ▲ +3%");
    expect(text).not.toMatch(/\$\d/);
  });

  test("the chart's caption under the chart, between the comparison and the cards; the owners' under their table", () => {
    const text = panel(null);
    const at = (words: string) => {
      expect(text).toContain(words);
      return text.indexOf(words);
    };
    expect(at("A Oct 22 – Oct 28 ✕")).toBeLessThan(
      at("Each bar is a day's total")
    );
    expect(at("Nov 3 Each bar is a day's total")).toBeLessThan(
      at("Runner-hours per day in B")
    );
    expect(at("Owners · runner-hours per day")).toBeLessThan(
      at(
        "Click an owner to highlight it across the page and see what changed for it below; click again to clear. Click a header to sort."
      )
    );
    expect(panel(rates)).toContain("Owners · $ per day");
  });

  test("days without data, said only when a period has some", () => {
    expect(panel(null)).not.toContain("has data on");
    // Without Nov 2's daily totals, B dragged across Nov 1 – Nov 4 has
    // data on 3 of its 4 days.
    const gone = answer.daily.days.indexOf("2026-11-02");
    const gappy = {
      ...answer,
      daily: {
        ...answer.daily,
        days: answer.daily.days.filter((_, d) => d !== gone),
        pushes: answer.daily.pushes.filter((_, d) => d !== gone),
        cells: answer.daily.cells
          .filter(([d]) => d !== gone)
          .map(([d, ...rest]) => [d > gone ? d - 1 : d, ...rest]),
      },
    } as typeof answer;
    let renderer: ReturnType<typeof create> | undefined;
    act(() => {
      renderer = create(
        <TrendPanel
          answer={gappy}
          loading={false}
          rollup="day"
          onRollupChange={noop}
          rates={null}
          scope={null}
          highlighted={[]}
          onToggleOwners={noop}
          onOwnersChange={noop}
        />,
        { createNodeMock: nodeMock }
      );
    });
    const plot = () =>
      renderer!.root.find(
        (n) => typeof n.type === "string" && n.props.role === "group"
      );
    const pointer = (clientX: number) => ({
      button: 0,
      clientX,
      shiftKey: false,
      pointerId: 1,
      currentTarget: { setPointerCapture: noop },
    });
    act(() => plot().props.onPointerDown(pointer(105)));
    act(() => plot().props.onPointerMove(pointer(135)));
    act(() => plot().props.onPointerUp(pointer(135)));
    const text = textOf(renderer!.toJSON());
    expect(text).toContain("B Nov 1 – Nov 4");
    expect(text).toContain("Nov 1 – Nov 4 · B has data on 3 of 4 days");
    expect(text).not.toContain("A has data on");
    act(() => renderer!.unmount());
  });

  test("the page's highlighted owners are the cards' and are ticked", () => {
    const text = panel(rates, ["inductor"], "pull + trunk");
    expect(text).toContain("Trends · pull + trunk");
    expect(text).toContain("inductor: $ per day in B $15 ▲ +20% vs A ($13)");
    expect(text).toContain("inductor: $ per runner-hour $1.25/h same as A");
    // $15 a day is $5,475 a year, $456.25 a month.
    expect(text).toContain(
      "inductor: Projected $ per year $5.5K $456 per month at B's daily average · 25% of hours unpriced"
    );
    expect(text).toContain("✓ inductor 54%");
    expect(text).toContain(
      "Each bar is a day's total. Solid: inductor; pale: the rest."
    );
    // The Owner key says whose the panel is.
    expect(text).toContain("Trends · pull + trunk · last 42 days inductor Day");
    expect(panel(rates)).toContain(
      "Trends · all workflows · last 42 days All owners Day"
    );
  });

  test("B's pace for any owners; none where none of their hours has a rate", () => {
    // dynamo: $8 a day, $2,920 a year, $243.33 a month; the card's change
    // as the table writes it, with a true minus.
    const dynamo = panel(rates, ["dynamo"]);
    expect(dynamo).toContain("dynamo: $ per day in B $8 ▼ −20% vs A ($10)");
    expect(dynamo).toContain(
      "dynamo: Projected $ per year $2.9K $243 per month at B's daily average"
    );
    // distributed: $3.75 a day, $1,368.75 a year.
    expect(panel(rates, ["distributed"])).toContain(
      "distributed: Projected $ per year $1.4K $114 per month at B's daily average"
    );
    // $23 a day together, $8,395 a year; inductor's 28 h on A10G have no
    // rate, so the pace is at least that.
    const both = panel(rates, ["inductor", "dynamo"]);
    expect(both).toContain(
      "inductor + dynamo: Projected $ per year $8.4K $700 per month at B's daily average · 13% of hours unpriced"
    );
    // No owner ran $1 a day in both: the same as A.
    expect(panel(rates, ["unattributed:no_owner"])).toContain(
      "No owner: $ per day in B $1 same as A ($1) $7 total, Oct 29 – Nov 4"
    );
    // No test reports ran only on a runner rates.json has no rate for.
    const unpriced = panel(rates, ["unattributed:no_test_reports"]);
    expect(unpriced).toContain("100% of hours unpriced");
    expect(unpriced).not.toContain("Projected");
  });

  test("the Owner key picks one owner, or every owner, and its ‹ › keys step through the owners table's order", () => {
    const onOwnersChange = jest.fn();
    const render = (highlighted: string[], cost?: PreparedHours) => {
      let renderer: ReturnType<typeof create> | undefined;
      act(() => {
        renderer = create(
          <TrendPanel
            answer={answer}
            loading={false}
            rollup="day"
            onRollupChange={noop}
            rates={rates}
            scope={null}
            highlighted={highlighted}
            onToggleOwners={noop}
            onOwnersChange={onOwnersChange}
            runnerHours={cost}
          />,
          { createNodeMock: nodeMock }
        );
      });
      return renderer!;
    };
    let renderer = render([]);
    const select = () => renderer.root.findByType(HeaderSelect);
    const key = (label: string) =>
      renderer.root.find(
        (n) =>
          typeof n.type === "string" &&
          n.type === "button" &&
          n.props["aria-label"] === label
      );
    // Every owner first, then the table's order: by B in $.
    expect(select().props.display).toBe("All owners");
    expect(select().props.active).toBe(false);
    expect(
      select().props.options.map((o: { label: string }) => o.label)
    ).toEqual([
      "All owners",
      "inductor",
      "dynamo",
      "distributed",
      // Hours no owner is given, not owners.
      "No owner (unattributed)",
      "No test reports (unattributed)",
    ]);
    act(() => select().props.onChange("dynamo"));
    act(() => select().props.onChange(""));
    expect(onOwnersChange.mock.calls).toEqual([[["dynamo"]], [[]]]);
    // From every owner, › takes the first; there is nothing before it, and
    // the key says so, named and focusable, a press doing nothing.
    act(() => key("Next owner: inductor").props.onClick());
    expect(onOwnersChange).toHaveBeenLastCalledWith(["inductor"]);
    const first = key("Already at all owners");
    expect(first.props["aria-disabled"]).toBe(true);
    expect(first.props.onClick).toBeUndefined();
    expect(first.props.disabled).toBeFalsy();
    act(() => renderer.unmount());
    // At the last, a bucket, named as one; nothing after it.
    renderer = render(["unattributed:no_test_reports"]);
    expect(select().props.display).toBe("No test reports (unattributed)");
    expect(key("Previous owner: No owner (unattributed)")).toBeDefined();
    expect(key("Already at the last owner").props["aria-disabled"]).toBe(true);
    act(() => renderer.unmount());
    // From dynamo, ‹ inductor and › distributed; the key is filled.
    renderer = render(["dynamo"]);
    expect(select().props.display).toBe("dynamo");
    expect(select().props.active).toBe(true);
    expect(select().props.value).toBe("dynamo");
    act(() => key("Previous owner: inductor").props.onClick());
    expect(onOwnersChange).toHaveBeenLastCalledWith(["inductor"]);
    act(() => key("Next owner: distributed").props.onClick());
    expect(onOwnersChange).toHaveBeenLastCalledWith(["distributed"]);
    act(() => renderer.unmount());
    // From the first, ‹ goes back to every owner; several highlighted are
    // named, and no one item is checked.
    renderer = render(["inductor", "dynamo"]);
    expect(select().props.display).toBe("inductor + dynamo");
    expect(
      select().props.options.some(
        (o: { value: string }) => o.value === select().props.value
      )
    ).toBe(false);
    act(() => key("Back to all owners").props.onClick());
    expect(onOwnersChange).toHaveBeenLastCalledWith([]);
    act(() => renderer.unmount());
    // Only owners the page can highlight, those of the cost answer: here
    // inductor and No owner, so › from inductor skips to No owner.
    const cost = {
      ...runnerHours,
      owners: ["inductor", "unattributed:no_owner"],
    } as PreparedHours;
    renderer = render(["inductor"], cost);
    expect(
      select().props.options.map((o: { label: string }) => o.label)
    ).toEqual(["All owners", "inductor", "No owner (unattributed)"]);
    act(() => key("Next owner: No owner (unattributed)").props.onClick());
    expect(onOwnersChange).toHaveBeenLastCalledWith(["unattributed:no_owner"]);
    act(() => renderer.unmount());
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
      "What changed · all owners · per day · A → B Per day Per commit Comparing A and B…"
    );
  });

  test("for a highlighted owner, per push to main, and what changed by machine", () => {
    answering(changes);
    const text = panel(rates, ["inductor"]);
    // $35 of push:main L4 hours over 56 pushes, $0.625 a push, against
    // $26.25 over 70, $0.375: whole dollars on the page; 35 of inductor's
    // 112 h in B are pushes to main.
    expect(text).toContain(
      "inductor: $ per commit in B $0.63 ▲ +67% vs A ($0.38) What one push to main costs, with every test running (no target determination). 8 pushes a day; their jobs are 31% of B's runner-hours for inductor."
    );
    // The heading names the answer's periods.
    expect(text).toContain(
      "What changed · inductor · per day · A Oct 22 – Oct 28 → B Oct 29 – Nov 4 Per day Per commit"
    );
    // In $, what made the change; the figures themselves are the table's
    // first row.
    expect(text).toContain(
      "▲ +$2.50 a day (+20%) , all from more runner-hours on the same machine mix."
    );
    expect(text).not.toContain("$13 a day in A");
    expect(text).toContain(
      "Pushes to main: 10 a day in A, 8 in B · $0.38 → $0.63 per commit (+67%)."
    );
    // rates.json prices L4 at $1.25 an hour and not A10G.
    expect(text).toContain(
      "Machine Share of B A / day B / day Change % All machines 100% $13 $15 ▲ +$2.50 ▲ +20% ▸ NVIDIA L4 100% $13 $15 ▲ +$2.50 ▲ +20% ▸ NVIDIA A10G — — — — unpriced"
    );
    expect(text).toContain(
      "Bars show B; ticks mark A. Click a machine to list its runners."
    );
    expect(text).not.toContain("with data");
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
        onOwnersChange={noop}
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
    // The last 7 days keep Nov 4, faded and warned of; A and B mix
    // weekends alike.
    const text = panel(null, [], null, filling);
    expect(text).toContain("A Oct 22 – Oct 28 ✕ · B Oct 29 – Nov 4");
    expect(text).toContain(
      "⚠ Nov 4 is incomplete: some of its jobs are still running, so it reads low until the rollup reruns after 03:00 UTC."
    );
    expect(text).not.toContain("weekend");
    expect(text).toContain("Faded bars have incomplete data.");
    // 266 h over B's 7 days, 38 h a day: 13,870 h a year, 1,156 h a month.
    // B reads low, as its warning says, so no weekday caveat.
    expect(text).toContain(
      "Projected runner-hours per year 13.9K h 1.2K h per month at B's daily average Owners"
    );
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
          onOwnersChange={noop}
        />,
        { createNodeMock: nodeMock }
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
      "⚠ Nov 4 is incomplete: some of its jobs are still running, so it reads low until the rollup reruns after 03:00 UTC."
    );
    expect(dragged).toContain(
      "⚠ A and B mix weekends differently (A: 1 of 3 days on a weekend, B: 0 of 1). Weekends run far fewer jobs; compare matching weekdays, whole weeks, or per commit."
    );
    // B is a weekday still filling: it reads low, as its warning says, not
    // high.
    expect(dragged).toContain(
      "Projected runner-hours per year13.9K h1.2K h per month at B's daily average"
    );
    expect(dragged).not.toContain("likely high");
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
        onOwnersChange={noop}
      />
    );
    expect(markup).toMatch(/aria-disabled="true"[^>]*>Week</);
    expect(markup).toMatch(/aria-disabled="true"[^>]*>Month</);
    expect(markup).not.toMatch(/aria-disabled="true"[^>]*>Day</);
    expect(markup).toContain('aria-label="A bar per day, the last 42 days"');
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
        onOwnersChange={noop}
      />
    );
    expect(weeks).not.toMatch(/aria-disabled="true"[^>]*>Week</);
    expect(weeks).toMatch(/aria-disabled="true"[^>]*>Month</);
    expect(weeks).toContain('aria-label="A bar per week, the last 26 weeks"');
  });

  test("the band names the lookback of the bars on screen, the last answer's while the next loads", () => {
    const band = (answer: CostTrend | undefined) =>
      words(
        renderToStaticMarkup(
          <TrendPanel
            answer={answer}
            loading
            rollup="week"
            onRollupChange={noop}
            rates={null}
            scope={null}
            highlighted={[]}
            onToggleOwners={noop}
            onOwnersChange={noop}
          />
        )
      );
    // Week clicked, the day answer still on screen.
    expect(band(answer)).toContain("Trends · all workflows · last 42 days");
    expect(band(undefined)).toContain("Trends · all workflows · last 26 weeks");
  });

  test("while yesterday fills, the last 7 days keep it; Yesterday's preset says what it waits for", () => {
    const days: string[] = [];
    for (let d = 21; d <= 35; d++) {
      days.push(new Date(Date.UTC(2026, 9, d)).toISOString().slice(0, 10));
    }
    const markup = renderToStaticMarkup(
      <TrendPanel
        answer={{
          ...answer,
          cells: [],
          daily: {
            ...answer.daily,
            days,
            filling: ["2026-11-04"],
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
        onOwnersChange={noop}
      />
    );
    const text = words(markup);
    expect(text).toContain("· all workflows · last 42 days");
    expect(text).toContain("A Oct 22 – Oct 28 ✕ · B Oct 29 – Nov 4 ⚠ Nov 4");
    // No hours at all: the axis runs to 1 h.
    expect(text).toContain("0 1 h A B Oct 21");
    expect(markup).toMatch(/aria-pressed="true"[^>]*>Last 7 days vs prior 7</);
    expect(markup).toMatch(
      /aria-disabled="true" aria-label="Waits for Nov 4: incomplete until the rollup reruns after 03:00 UTC"[^>]*>Yesterday vs same day last week</
    );
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
        onOwnersChange={noop}
      />
    );
    expect(words(empty)).toContain("No runner-hours in this window yet.");
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

  test("in runner-hours, the pushes, then every machine and each machine's share of B, A and B per day, change and %", () => {
    const text = changesText(changes);
    // The whole change is the table's first row, said once.
    expect(text).not.toContain("a day in A (");
    expect(text).toContain(
      "Pushes to main: 10 a day in A, 8 in B · 0.4 h → 0.6 h per commit (+56%)."
    );
    expect(text).toContain(
      "Machine Share of B A / day B / day Change % All machines 100% 14 h 16 h ▲ +2 h ▲ +14% ▸ NVIDIA L4 75% 10 h 12 h ▲ +2 h ▲ +20% ▸ NVIDIA A10G 25% 4 h 4 h — —"
    );
    expect(text).toContain(
      "Bars show B; ticks mark A. Click a machine to list its runners."
    );
    expect(text).not.toContain("Per day with data");
  });

  test("in $, what made the change: more runner-hours, and pricier machines", () => {
    // Same machine mix: all of inductor's $2.50 a day, or $0.25 a commit,
    // is more L4 hours.
    expect(changesText(changes, rates, "commit")).toContain(
      "▲ +$0.25 a commit (+67%) , all from more runner-hours on the same machine mix."
    );
    // With A10G at $0.50 too: $14.50 a day on 14 h, then $17 on 16 h;
    // 2 h more at A's $1.0357 an hour, and 16 h at $0.0268 more each.
    const both = parseRates(
      JSON.stringify({
        "mt-l-x86aavx2-11-41-l4": 1.25,
        "mt-l-x86aavx2-11-41-a10g": 0.5,
      }),
      "both.json"
    );
    expect(changesText(changes, both)).toContain(
      "▲ +$2.50 a day (+17%) : ▲ +$2.07 from more runner-hours, ▲ +$0.43 from pricier machines."
    );
    // No change, nothing to explain: B as A.
    const same = {
      ...changes,
      cells: changes.cells
        .filter(([side]) => side === 0)
        .flatMap(([, l, h, m]) => [
          [0, l, h, m] as [number, number, number, number],
          [1, l, h, m] as [number, number, number, number],
        ]),
    };
    expect(changesText(same, rates)).not.toContain("from more runner-hours");
    expect(changesText(same, rates)).toContain("All machines 100% $13 $13 — —");
  });

  test("per commit: each machine's push:main runner-hours over the pushes to main", () => {
    // L4: 21 push:main hours over 70 pushes, then 28 over 56; A10G: 7 over
    // 70, then 7 over 56.
    const text = changesText(changes, null, "commit");
    expect(text).toContain(
      "What changed · inductor · per commit · A Oct 22 – Oct 28 → B Oct 29 – Nov 4"
    );
    expect(text).toContain(
      "Machine Share of B A / commit B / commit Change % All machines 100% 0.4 h 0.6 h ▲ +0.2 h ▲ +56% ▸ NVIDIA L4 80% 0.3 h 0.5 h ▲ +0.2 h ▲ +67% ▸ NVIDIA A10G 20% 0.1 h 0.1 h ▲ &lt;0.1 h ▲ +25%"
    );
    // Said once, per commit only, in the pushes line.
    expect(text).toContain(
      "Pushes to main: 10 a day in A, 8 in B. Per commit is what one push to main costs, with every test running (no target determination), so only the machines main runs on appear."
    );
    expect(text).not.toContain("⚠");
    expect(changesText(changes)).not.toContain(
      "only the machines main runs on"
    );
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
      /aria-disabled="true"[^>]*>Per commit</
    );
    expect(renderToStaticMarkup(element(changes))).not.toMatch(
      /aria-disabled="true"[^>]*>Per commit</
    );
  });

  test("names several owners in the page's order, as the rest of the panel does", () => {
    const two = words(
      renderToStaticMarkup(
        <TrendChanges
          changes={{ ...changes, owners: ["dynamo", "inductor"] }}
          loading={false}
          error={undefined}
          onRetry={noop}
          rates={null}
          per="day"
          onPerChange={noop}
          prepared={runnerHours}
          highlighted={["inductor", "dynamo"]}
        />
      )
    );
    expect(two).toContain("What changed · inductor + dynamo · per day");
  });

  test("for every owner, the same machines", () => {
    const text = changesText(everyone);
    expect(text).toContain(
      "What changed · all owners · per day · A Oct 22 – Oct 28 → B Oct 29 – Nov 4"
    );
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
      "NVIDIA L4: 10 h a day in A, 12 h in B. Click to list its runners"
    );
    // A machine without a rate says so, not $0.
    let priced: ReturnType<typeof create> | undefined;
    act(() => {
      priced = create(element(changes, rates));
    });
    expect(
      priced!.root.find(
        (n) =>
          typeof n.type === "string" &&
          n.props.role === "row" &&
          typeof n.props.title === "string" &&
          n.props.title.startsWith("NVIDIA A10G:")
      ).props.title
    ).toBe("NVIDIA A10G: no rate in the rates file. Click to list its runners");
    act(() => priced!.unmount());
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

  test("past the largest 5 rows, the rest fold into one; a click lists them and Show fewer folds them back", () => {
    // Nine machines, M1 to M6 colored, O1 and O2 not, and a label no
    // machine is known for; runner-hours a side over 7 days each.
    const HOURS: [string, number, number][] = [
      ["m1", 63, 70],
      ["m2", 56, 56],
      ["m3", 49, 42],
      ["m4", 28, 35],
      ["m5", 28, 28],
      ["m6", 14, 21],
      ["o1", 21, 14],
      ["o2", 0, 7],
      ["u", 7, 7],
    ];
    const many: CostChanges = {
      ...everyone,
      labels: HOURS.map(([l]) => l),
      cells: HOURS.flatMap(([, a, b], l) => [
        ...(a > 0 ? [[0, l, a, 0] as [number, number, number, number]] : []),
        [1, l, b, 0] as [number, number, number, number],
      ]),
    };
    const MACHINES = ["M1", "M6", "M2", "M3", "M4", "M5", "O1", "O2"];
    // A cost answer as far as the table reads one: each label's machine,
    // the first six machines colored, and Unknown machine.
    const fake = {
      machines: [...MACHINES, NOT_PROBED],
      colored: [0, 1, 2, 3, 4, 5],
      runnerLabels: ["m1", "m6", "m2", "m3", "m4", "m5", "o1", "o2"],
      rowLabel: Int32Array.from([0, 1, 2, 3, 4, 5, 6, 7]),
      rowMachine: Int32Array.from([0, 1, 2, 3, 4, 5, 6, 7]),
      rowRunnerHours: Float64Array.from([1, 1, 1, 1, 1, 1, 1, 1]),
    } as unknown as PreparedHours;
    let renderer: ReturnType<typeof create> | undefined;
    act(() => {
      renderer = create(
        <TrendChanges
          changes={many}
          loading={false}
          error={undefined}
          onRetry={noop}
          rates={null}
          per="day"
          onPerChange={noop}
          prepared={fake}
        />
      );
    });
    const rows = () =>
      renderer!.root.findAll(
        (n) => typeof n.type === "string" && n.props.role === "row"
      );
    const text = () => textOf(renderer!.toJSON());
    // The header, every machine, M1 to M5, and M6, the others and Unknown
    // machine folded: 2 + 3 + 0 + 1 h a day in A, 3 + 2 + 1 + 1 in B, 7 of
    // B's 40.
    expect(rows()).toHaveLength(8);
    expect(text()).toContain("All machines100%38 h40 h▲ +2 h▲ +5%");
    expect(text()).toContain("▸4 more machines18%6 h7 h▲ +1 h▲ +17%");
    expect(text()).not.toContain("Other machines");
    const more = rows()[7];
    expect(more.props["aria-expanded"]).toBe(false);
    expect(more.props.title).toBe(
      "4 more machines: 6 h a day in A, 7 h in B. Click to list them"
    );
    act(() => more.props.onClick());
    // Listed: M6, the others together, Unknown machine, and Show fewer.
    expect(rows()).toHaveLength(11);
    expect(text()).toContain("▸M68%2 h3 h▲ +1 h▲ +50%");
    expect(text()).toContain("Other machines (2)");
    expect(text()).toContain("Show fewer ▴");
    const less = rows()[10];
    expect(less.props["aria-expanded"]).toBe(true);
    act(() => less.props.onClick());
    expect(rows()).toHaveLength(8);
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
    onRangeChange: (_w: "a" | "b", _r: PeriodRange) => void = noop
  ) => (
    <TrendChart
      prepared={prepared}
      series={trendSeries(prepared, rates, new Set(["inductor"]))}
      highlighting
      a={A}
      b={B}
      onRangeChange={onRangeChange}
    />
  );

  test("a bar a period, its tooltip its amount and the highlighted owners'", () => {
    const markup = renderToStaticMarkup(chart());
    const titles = Array.from(
      unstyled(markup).matchAll(/ title="([^"]*)"/g),
      (m) => m[1]
    );
    expect(titles).toHaveLength(14);
    expect(titles[0]).toBe("Thu Oct 22: $24 · highlighted: $13");
    expect(titles[13]).toBe("Wed Nov 4: $28 · highlighted: $15");
    expect(words(markup)).toMatch(/^0 \$10 \$20 \$30 A B Oct 22/);
  });

  test("bars keep their gap at 42", () => {
    const days = answer.periods;
    const all = prepareTrend({
      ...answer,
      daily: {
        ...answer.daily,
        days,
        pushes: days.map(() => 0),
        cells: [],
      },
    });
    expect(all.periods).toHaveLength(42);
    const markup = renderToStaticMarkup(
      <TrendChart
        prepared={all}
        series={trendSeries(all, null, new Set())}
        highlighting={false}
        a={null}
        b={null}
        onRangeChange={noop}
      />
    );
    expect(markup).toContain("padding-left:15%;padding-right:15%");
    expect(markup).not.toContain("padding-left:1px");
  });

  test("small values keep their fractions on the axis and in each bar's tooltip", () => {
    // Per commit in $: $6.50 a day over 10 pushes in A, $8.50 over 8 in B.
    const markup = renderToStaticMarkup(
      <TrendChart
        prepared={prepared}
        series={trendSeries(prepared, rates, new Set(), "commit")}
        highlighting={false}
        a={A}
        b={B}
        onRangeChange={noop}
      />
    );
    const titles = Array.from(
      unstyled(markup).matchAll(/ title="([^"]*)"/g),
      (m) => m[1]
    );
    expect(titles[0]).toBe("Thu Oct 22: $0.65");
    expect(titles[13]).toBe("Wed Nov 4: $1.06");
    expect(words(markup)).toMatch(/^0 \$0\.50 \$1 \$1\.50 A B/);
  });

  test("dragging across the bars sets B; with Shift held, A", () => {
    const onRangeChange = jest.fn();
    let renderer: ReturnType<typeof create> | undefined;
    // 14 bars across 140 px: 10 px each.
    act(() => {
      renderer = create(chart(onRangeChange), {
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
    const onExpandedChange = jest.fn();
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
          onExpandedChange={onExpandedChange}
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
    expect(rows[2].props.title).toBe("Highlight inductor across the page");
    expect(textOf(rows[3].children)).toContain("2 more owners ▸");
    expect(rows[3].props["aria-expanded"]).toBe(false);
    expect(rows[3].props.title).toBe("List the 2 other owners");
    act(() => rows[3].props.onClick());
    expect(onExpandedChange).toHaveBeenLastCalledWith(true);
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
      "B: Oct 29 – Nov 4 · click to sort, smallest first"
    );
    const sortButton = (h: (typeof headers)[number]) =>
      h.find((n) => typeof n.props.onClick === "function");
    act(() => sortButton(headers[2]).props.onClick());
    act(() => sortButton(headers[1]).props.onClick());
    expect(onSort.mock.calls).toEqual([["delta"], ["b"]]);
    act(() => renderer!.unmount());
  });

  test("listed, Show fewer folds the owners back; a highlighted row says it stops", () => {
    const onExpandedChange = jest.fn();
    let renderer: ReturnType<typeof create> | undefined;
    act(() => {
      renderer = create(
        <TrendTable
          rows={trendRows(
            prepared,
            rates,
            A,
            B,
            new Set(["dynamo"]),
            DEFAULT_TREND_SORT,
            true,
            1
          )}
          unit="cost"
          per="day"
          rollup="day"
          periodsLabel="Oct 22 – Nov 4"
          highlighted={new Set(["dynamo"])}
          aLabel="Oct 22 – Oct 28"
          bLabel="Oct 29 – Nov 4"
          sort={DEFAULT_TREND_SORT}
          onSort={noop}
          onToggleOwners={noop}
          onExpandedChange={onExpandedChange}
        />
      );
    });
    const rows = renderer!.root.findAll(
      (n) => typeof n.type === "string" && n.props.role === "row"
    );
    // The header, every owner, inductor, dynamo, distributed, nothing to
    // fold back (dynamo is highlighted, distributed alone), the buckets.
    expect(rows.map((r) => textOf(r.children).split(/\d/)[0])).toEqual([
      "OwnerShare of BA / dayB / dayChange%Per commit A → BDaily trend",
      "All owners",
      "inductor",
      "✓ dynamo",
      "distributed",
      "No owner",
      "No test reports",
    ]);
    expect(rows[3].props.title).toBe("Stop highlighting dynamo");
    act(() => renderer!.unmount());
    // With nothing highlighted, two owners past the top fold back.
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
            true,
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
          onSort={noop}
          onToggleOwners={noop}
          onExpandedChange={onExpandedChange}
        />
      );
    });
    const listed = renderer!.root.findAll(
      (n) => typeof n.type === "string" && n.props.role === "row"
    );
    expect(listed).toHaveLength(8);
    expect(textOf(listed[5].children)).toBe("Show fewer ▴");
    expect(listed[5].props["aria-expanded"]).toBe(true);
    expect(listed[5].props.title).toBe(
      "Fold the owners past the top 8 back into one row"
    );
    act(() => listed[5].props.onClick());
    expect(onExpandedChange).toHaveBeenLastCalledWith(false);
    act(() => renderer!.unmount());
  });
});
