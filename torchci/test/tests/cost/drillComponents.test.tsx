// The drill's components rendered on the server from the captured /scope and
// /cases answers (SWR fallback keyed by the URLs useDrill asks), read as
// words: the trail's pills, the head, the table's total, rows and fold line,
// the canvas header, the file level's cases button, the cases panel, the
// too-big gate that offers one environment instead of a table, rows opened
// in place, and the head's totals in hours and in $ with the FAKE weekly
// rates.

import DrillTable from "components/tests/cost/drill/DrillTable";
import ScopeHead from "components/tests/cost/drill/ScopeHead";
import ScopeTrail from "components/tests/cost/drill/ScopeTrail";
import {
  type ExpandState,
  TreeRow,
  useExpandState,
} from "components/tests/cost/drill/TreeRows";
import {
  type DrillModel,
  useDrill,
} from "components/tests/cost/drill/useDrill";
import {
  type Compare,
  type CostCases,
  costCasesUrl,
  type CostScope,
  costScopeUrl,
  type DrillQuery,
  type Per,
  type Pill,
  type Pricer,
  type Rollup,
  type ScopeBy,
  type Unit,
} from "lib/api/tests/cost/contracts";
import {
  amount,
  arrowText,
  changeMetric,
  changeScale,
  halfScale,
  levelView,
  type MachineOpens,
  rowByKey,
} from "lib/tests/cost/drill";
import { makePricer, parseRatesFiles } from "lib/tests/cost/ratePeriods";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { SWRConfig } from "swr";
import CASES_OK from "./cases_ok.json";
import CASES_TOO_BIG from "./cases_too_big.json";
import FILE from "./scope_file.json";
import OWNER from "./scope_owner.json";
import PAIR from "./scope_pair.json";
import PAIR_LABEL from "./scope_pair_label.json";
import ROOT from "./scope_root.json";

const REPO = "pytorch/pytorch";
const A = { from: "2026-11-05", to: "2026-11-11" };
const B = { from: "2026-11-12", to: "2026-11-18" };
const compare: Compare = { rollup: "day", a: A, b: B, preset: null };
const IND: Pill = { dim: "o", value: "inductor" };
const AVX: Pill = { dim: "m", value: "Linux x86_64 avx512" };
const FLEX: Pill = { dim: "f", value: "test/inductor/test_flex_attention.py" };
const TI: Pill = { dim: "f", value: "test/inductor/test_torchinductor.py" };
const scope = (trail: Pill[], by: ScopeBy) =>
  costScopeUrl(REPO, [], A, B, trail, by);
const FALLBACK: Record<string, unknown> = {
  [scope([], "o")]: ROOT,
  // In $ the drill asks for day pieces; the root's numbers stand in.
  [costScopeUrl(REPO, [], A, B, [], "o", "day")]: {
    ...(ROOT as object),
    piece: "day",
  },
  [scope([], "m")]: { ...(OWNER as object), trail: [], by: "m" },
  [scope([IND], "m")]: OWNER,
  [scope([IND, AVX], "f")]: PAIR,
  [scope([IND, AVX, FLEX], "lane")]: FILE,
  [scope([IND, AVX, TI], "lane")]: {
    ...(FILE as unknown as CostScope),
    trail: [IND, AVX, TI],
  },
  [scope([IND, AVX], "label")]: PAIR_LABEL,
  // Shaped as avx512's own runner labels at the machine root (inductor's
  // numbers; the words are what's read).
  [scope([AVX], "label")]: { ...(PAIR_LABEL as object), trail: [AVX] },
  [costCasesUrl(REPO, FLEX.value, AVX.value, A, B)]: CASES_OK,
  [costCasesUrl(REPO, TI.value, AVX.value, A, B)]: CASES_TOO_BIG,
};

const QUERY: DrillQuery = {
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

interface Pricing {
  unit?: Unit;
  per?: Per;
  rollup?: Rollup;
  pricer?: Pricer | null;
}

function Inner({
  query,
  part,
  onQueryChange = () => {},
  pricing = {},
}: {
  query: DrillQuery;
  part: (_drill: DrillModel) => ReactNode;
  onQueryChange?: (_patch: Partial<DrillQuery>) => void;
  pricing?: Pricing;
}) {
  const drill = useDrill({
    repo: REPO,
    workflows: [],
    compare,
    query,
    onQueryChange,
    per: pricing.per ?? "day",
    rollup: pricing.rollup ?? "day",
    unit: pricing.unit ?? "hours",
    pricer: pricing.pricer ?? null,
    runnerHours: undefined,
  });
  return <>{part(drill)}</>;
}

function render(
  patch: Partial<DrillQuery>,
  part: (_drill: DrillModel) => ReactNode,
  pricing: Pricing = {}
): string {
  return renderToStaticMarkup(
    <SWRConfig value={{ provider: () => new Map(), fallback: FALLBACK }}>
      <Inner query={{ ...QUERY, ...patch }} part={part} pricing={pricing} />
    </SWRConfig>
  );
}

function words(markup: string): string {
  return markup
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, "")
    .replace(/<wbr\/?>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const all = (drill: DrillModel) => (
  <>
    <ScopeTrail drill={drill} />
    <ScopeHead drill={drill} />
    <DrillTable drill={drill} />
  </>
);

describe("drill components (SSR)", () => {
  test("the root: one pill, the root head with pushes, owners with buckets last", () => {
    const html = render({}, all);
    const w = words(html);
    expect(w).toContain(
      "SCOPE By owner By machine All test jobs 43.9K h ▼ −13%"
    );
    expect(w).toContain("+ owner");
    expect(html).toContain('aria-label="Scope"');
    expect(w).toContain("Pushes to main");
    expect(w).toContain("B per day 43.9K h ▼ −6.8K h ▼ −13%");
    expect(w).toContain("A per day 50.7K h");
    expect(w).toContain("Per commit");
    // The page's facts sit under its title, not here.
    expect(w).not.toContain("Projected a year");
    expect(w).not.toContain("Attributed to owners");
    expect(w).not.toContain("PR update signals");
    expect(w).toContain("Owners · runner-hours a day");
    expect(w).toMatch(/\d+ more owners ▸/);
    expect(w.indexOf("No test reports")).toBeGreaterThan(
      w.indexOf("more owners")
    );
    expect(w).not.toMatch(/other owners/); // no fold line at the root
    expect(w).not.toContain("bars rescale"); // no canvas at the root
    expect(w).toContain("Open in tests list ↗");
  });

  test("a pinned pair: pills with ⇄, the sentence, total, selected row, canvas, fold line", () => {
    const html = render({ trail: [IND, AVX] }, all);
    const w = words(html);
    expect(w).toContain("inductor 11.8K h ▼ −18%");
    expect(w).toContain("Linux x86_64 avx512 4.8K h ▼ −33%");
    expect(html).toContain('aria-label="Flip owner and machine"');
    expect(html).toContain('aria-label="Drop inductor"');
    expect(w).toContain("+ test file");
    expect(w).toContain("Share of inductor 41%");
    expect(w).not.toContain("Projected a year");
    expect(w).not.toContain("Attributed to owners");
    expect(w).toContain(
      "inductor on Linux x86_64 avx512 fell 2.4K h a day (−33%) from A to B."
    );
    expect(w).toContain("All of inductor");
    expect(w).toContain("Test files of inductor on Linux x86_64 avx512");
    expect(w).toContain("bars rescale to this level");
    expect(w).toMatch(/\d+ other machines/);
    expect(w).toMatch(/\d+ more test files ▸/);
  });

  test("a file on a machine: lanes and the cases button", () => {
    const w = words(render({ trail: [IND, AVX, FLEX] }, all));
    expect(w).toContain("Environments of test_flex_attention.py");
    expect(w).toContain("Every lane runs on");
    expect(w).toContain("Test time a day");
    expect(w).toContain("Load configurations and test cases · last 14 days");
    expect(w).toMatch(/\d+ other test files/);
  });

  test("configurations and cases once asked", () => {
    const w = words(render({ trail: [IND, AVX, FLEX], tests: true }, all));
    expect(w).toContain("Configurations · test time a day");
    expect(w).toContain(
      "Test cases of test_flex_attention.py · test × configuration"
    );
    expect(w).toContain("Biggest moves");
    expect(w).toContain("Rank by Change from time per run All change a day");
    expect(w).toMatch(/Showing 12 of \d+ tests × configuration/);
    expect(w).toContain(
      "Test-level figures: per day, all workflows and triggers, last 14 days"
    );
    expect(w).toContain("Test-level A covers Nov 7–11 (5 of 7 days)");
  });

  test("too big to scan: no table, one environment at a time", () => {
    const html = render({ trail: [IND, AVX, TI], tests: true }, all);
    const w = words(html);
    expect(w).toContain("has too many test runs on Linux x86_64 avx512");
    expect(w).toContain("Open it in the tests list");
    expect(w).not.toContain("Configurations · test time a day");
    expect(w).not.toContain("Test cases of");
    expect(html).not.toContain('aria-label="Configurations"');
    // Every lane of the captured answer is too big as well: nothing to try.
    expect(w).not.toContain("Try one environment:");
    expect(w).toContain("Each environment is too big to scan on its own");
  });

  test("too big with lanes that pass offers them", () => {
    const bigUrl = costCasesUrl(REPO, TI.value, AVX.value, A, B);
    const answer = CASES_TOO_BIG as unknown as CostCases;
    const html = renderToStaticMarkup(
      <SWRConfig
        value={{
          provider: () => new Map(),
          fallback: {
            ...FALLBACK,
            [bigUrl]: {
              ...answer,
              lanes: answer.lanes.map((l, i) => ({ ...l, tooBig: i > 0 })),
            },
          },
        }}
      >
        <Inner
          query={{ ...QUERY, trail: [IND, AVX, TI], tests: true }}
          part={all}
        />
      </SWRConfig>
    );
    const w = words(html);
    expect(w).toContain("Try one environment:");
    expect(w).not.toContain("Test cases of");
  });

  test("machines first", () => {
    const w = words(render({ root: "m" }, all));
    expect(w).toContain("SCOPE By owner By machine All test jobs");
    expect(w).toContain("+ machine");
    expect(w).toContain("Machines · runner-hours a day");
    expect(w).toContain("Linux x86_64 avx512");
  });

  test("the head keeps A/B only: no year, owners or PR signals at the machine root or a machine", () => {
    for (const trail of [[], [AVX]]) {
      const w = words(
        render({ root: "m", trail }, (drill) => <ScopeHead drill={drill} />)
      );
      expect(w).toMatch(/B per day \S+ h/);
      expect(w).toContain("A per day");
      expect(w).toContain("Per commit");
      for (const gone of [
        "Projected a year",
        "Annualized",
        "Attributed to owners",
        "PR update signals",
        "PR merge signals",
      ]) {
        expect(w).not.toContain(gone);
      }
    }
  });

  test("the head's totals: each side over its days, after both per days, with its days in the title", () => {
    const head = (drill: DrillModel) => <ScopeHead drill={drill} />;
    const html = render({}, head);
    const w = words(html);
    expect(w).toContain("B total 307.1K h · 7 days");
    expect(w).toContain("A total 355K h · 7 days");
    const at = (s: string) => w.indexOf(s);
    expect(at("B per day")).toBeLessThan(at("A per day"));
    expect(at("A per day")).toBeLessThan(at("B total"));
    expect(at("B total")).toBeLessThan(at("A total"));
    expect(at("A total")).toBeLessThan(at("Per commit"));
    // Day view: per day is the first chips' own, no chip of its own.
    expect(w).not.toMatch(/ Per day /);
    expect(html).toContain('title="Nov 12–18"');
    expect(html).toContain('title="Nov 5–11"');
    // Per commit: still totals.
    const commit = words(render({}, head, { per: "commit" }));
    expect(commit).toContain("B per commit");
    expect(commit).toContain("B total 307.1K h · 7 days");
    // A scope's own, one level down.
    expect(words(render({ trail: [IND] }, head))).toMatch(
      /B total \S+ h · 7 days .*A total \S+ h · 7 days/
    );
  });

  test("the head, band and pill read per bar of the rollup: a week, a month", () => {
    const head = (drill: DrillModel) => <ScopeHead drill={drill} />;
    // A (Nov 5–11) and B (Nov 12–18) each straddle two Mon–Sun weeks, 4 and
    // 3 of 7 days: one week's worth each, so a week is the side's total.
    const week = words(render({}, head, { rollup: "week" }));
    // A and B (Thu–Wed) each touch two weeks: their average week.
    expect(week).toMatch(/B a week 153\.5K h ▼ −23\.9K h ▼ −13%/);
    expect(week).toContain("A a week 177.5K h");
    expect(week).toContain("B total 307.1K h · 7 days");
    expect(week).toMatch(/Per day 50\.7K h → 43\.9K h/);
    const at = (s: string) => week.indexOf(s);
    expect(at("A a week")).toBeLessThan(at("B total"));
    expect(at("A total")).toBeLessThan(at("Per day"));
    expect(at("Per day")).toBeLessThan(at("Per commit"));
    expect(words(render({}, all, { rollup: "week" }))).toContain(
      "Owners · runner-hours a week"
    );
    // A month: 7 of November's 30 days, so 30/7 of the total; the % holds
    // since both sides sit in one month.
    const month = words(render({}, head, { rollup: "month" }));
    // Each side sits in one month: the month's sum so far.
    expect(month).toMatch(/B a month 307\.1K h ▼ −47\.9K h ▼ −13%/);
    expect(month).toContain("A a month 355K h");
    expect(month).toContain("fell 47.9K h a month (−13%) from A to B");
    expect(month).toContain("B total 307.1K h · 7 days");
    // Per commit doesn't follow the rollup.
    const commit = words(render({}, head, { rollup: "week", per: "commit" }));
    expect(commit).toContain("B per commit");
    expect(commit).not.toContain("a week");
  });

  test("the head's totals in $ with the FAKE weekly rates: ≈ for unpriced days, B's after the file among them", () => {
    const fake = (name: string) => ({
      name,
      text: readFileSync(join(__dirname, name), "utf8"),
    });
    const head = (drill: DrillModel) => <ScopeHead drill={drill} />;
    const root = ROOT as unknown as CostScope;
    // Both files end Nov 15, so B (Nov 12–18) has 4 of 7 days priced.
    for (const [files, aDays, bNotes] of [
      [
        ["rates_FAKE_weekly.json", "rates_FAKE_weekly.meta.json"],
        "7 days",
        "\nProvisional: rates from Nov 9–13",
      ],
      [["rates_FAKE_weekly_gap.json"], "3 of 7 days priced", ""],
    ] as const) {
      const pricer = makePricer(parseRatesFiles(files.map(fake)));
      const { a, b } = levelView(root, { unit: "usd", per: "day", pricer })
        .total.totals;
      const approxA = aDays === "7 days" ? "" : "≈";
      for (const per of ["day", "commit"] as const) {
        const html = render({}, head, { unit: "usd", per, pricer });
        const w = words(html);
        expect(w).toContain(
          `B total ≈${amount("usd", b.value as number)} · 4 of 7 days priced`
        );
        expect(w).toContain(
          `A total ${approxA}${amount("usd", a.value as number)} · ${aDays}`
        );
        // B's title: its days and any provisional rates.
        expect(html).toContain(`title="Nov 12–18${bNotes}"`);
        expect(html).not.toMatch(/priced with|last period/);
        // The other per is over the priced days at their exact rates: no ≈.
        const t = levelView(root, { unit: "usd", per, pricer }).total;
        expect(t.approxB).toBe(false);
        expect(w).toContain(
          `${per === "day" ? "Per commit" : "Per day"} ${arrowText(
            "usd",
            t.other.a,
            t.other.b,
            t.approxA,
            t.approxB
          )}`
        );
        expect(w).not.toMatch(/Per (commit|day) \S+ → ≈/);
      }
    }
  });

  test("/scope asks for day pieces only in $; nothing of the rates file", () => {
    const pricer = makePricer(
      parseRatesFiles([
        {
          name: "rates_FAKE_weekly.json",
          text: readFileSync(join(__dirname, "rates_FAKE_weekly.json"), "utf8"),
        },
      ])
    );
    const urls = (pricing: Pricing, patch: Partial<DrillQuery> = {}) => {
      let model: DrillModel | null = null;
      render(patch, (d) => ((model = d), null), pricing);
      const m = model as unknown as DrillModel;
      return [m.canvas.url, ...m.levels.map((l) => l.url)];
    };
    const day = costScopeUrl(REPO, [], A, B, [], "o", "day");
    expect(urls({})).toEqual([scope([], "o")]);
    expect(urls({ pricer })).toEqual([scope([], "o")]);
    // $ without rates reads as hours.
    expect(urls({ unit: "usd" })).toEqual([scope([], "o")]);
    expect(urls({ unit: "usd", pricer })).toEqual([day]);
    expect(day).toBe(`${scope([], "o")}&piece=day`);
    // Every level of the trail alike.
    expect(urls({ unit: "usd", pricer }, { trail: [IND, AVX] })).toEqual([
      costScopeUrl(REPO, [], A, B, [IND, AVX], "f", "day"),
      costScopeUrl(REPO, [], A, B, [], "o", "day"),
      costScopeUrl(REPO, [], A, B, [IND], "m", "day"),
    ]);
  });

  test("a header row of column names that sort; the bar colours in a legend", () => {
    const html = render({ root: "m" }, all);
    const heads = [...html.matchAll(/role="columnheader"[^>]*>(.*?)<\/div>/g)]
      .map((m) => words(m[1]))
      .filter((t) => t !== "");
    expect(heads).toEqual([
      "A · Nov 5–11",
      "Machine",
      "B · Nov 12–18",
      "Change",
      "%",
    ]);
    // Change sets the order: its header says so; the others offer theirs.
    expect(html.match(/aria-sort="descending"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-sort="descending"[^>]*>(?:(?!<\/div>).)*Change/);
    expect(html.match(/aria-sort="none"/g)).toHaveLength(3);
    expect(html).toContain('title="Sort by A (Nov 5–11), largest first"');
    // The keys are in the band, not the header: A, B, lost, gained.
    const w = words(html);
    expect(w).toContain("Machines · runner-hours a day A B lost gained");
    expect(w).not.toContain("parent"); // no row open
    // The other sorts name their order in the header.
    const grew = render({ root: "m", sort: "grew" }, all);
    expect(grew).toMatch(/aria-sort="descending"[^>]*>(?:(?!<\/div>).)*Grew/);
    const b = render({ root: "m", sort: "b" }, all);
    expect(b).toMatch(/aria-sort="descending"[^>]*>(?:(?!<\/div>).)*B · Nov/);
  });

  test("no coach, toast or keycap text", () => {
    const w = words(render({ trail: [IND, AVX] }, all));
    expect(w).not.toMatch(/Shift-drag|Tip:|Got it|Press [A-Z]/);
  });

  // Open rows live in DrillTable's state; a stub opens the rows asked for.
  const openAt = (
    ids: string[],
    opens: Record<string, MachineOpens> = {}
  ): ExpandState => ({
    isOpen: (id) => ids.includes(id),
    toggle: () => {},
    opens: (id) => opens[id] ?? "o",
    setOpens: () => {},
    moreOpen: () => false,
    toggleMore: () => {},
    any: ids.length > 0,
    collapseAll: () => {},
  });
  // One row of the canvas (the root's level, or the trail's children) with
  // the rows under it.
  const tree = (exp: ExpandState, key: string) =>
    function OpenRow(drill: DrillModel) {
      const view = drill.canvas.view;
      const row = view ? rowByKey(view, key) : null;
      if (!view || !row) return <>missing {key}</>;
      return (
        <TreeRow
          drill={drill}
          exp={exp}
          row={row}
          scope={drill.trail}
          depth={0}
          scale={halfScale(view.rows)}
          change={changeScale(view.rows.map((r) => changeMetric(r, "h")))}
          totals={view.total}
          parent={null}
          swatch={null}
          stale={false}
        />
      );
    };
  const IND_ID = "o:inductor";
  const PAIR_ID = "o:inductor;m:Linux%20x86_64%20avx512";

  test("a row opens in place: its machines, a machine's runner labels, each value's share of its parent", () => {
    const html = render({}, tree(openAt([IND_ID, PAIR_ID]), "inductor"));
    const w = words(html);
    expect(w).toContain("11.8K h · 27%"); // inductor: share of all owners
    expect(w).toContain("Linux x86_64 avx512");
    expect(w).toContain("4.8K h · 41%"); // avx512: share of inductor
    expect(w).toContain("mt-l-x86iavx512-16-128 2.5K h · 51%"); // of avx512
    expect(w).toMatch(/\d+ more machines/);
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Drill in to inductor"');
    expect(html).toContain('aria-label="Drill in to Linux x86_64 avx512"');
    // Runner labels have no pill to focus on: a title only.
    expect(html).not.toContain('aria-label="Drill in to mt-l-');
    expect(html).toContain('title="mt-l-x86iavx512-16-128 · workflows: pull');
    // Under an owner a machine lists its labels directly: no switch.
    expect(w).not.toContain("Owners | Runners");
  });

  test("by machine: an open machine offers Owners | Runners", () => {
    const id = "m:Linux%20x86_64%20avx512";
    const runners = render(
      { root: "m" },
      tree(openAt([id], { [id]: "label" }), AVX.value)
    );
    expect(words(runners)).toContain("Owners | Runners");
    expect(runners).toMatch(/aria-pressed="true"[^>]*>Runners/);
    expect(words(runners)).toContain("mt-l-x86iavx512-16-128");
    // Owners, the default, asks /scope(avx512, by=o): a slim loading line
    // until it answers.
    const owners = render({ root: "m" }, tree(openAt([id]), AVX.value));
    expect(owners).toMatch(/aria-pressed="true"[^>]*>Owners/);
    expect(words(owners)).toContain(
      "Loading the owners of Linux x86_64 avx512"
    );
  });

  test("closed rows: carets, Focus keys and no Collapse all", () => {
    const html = render({}, all);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Drill in to inductor"');
    expect(words(html)).not.toContain("Collapse all");
  });

  test("open rows: closing one closes what's inside it; each view keeps its own", () => {
    let exp!: ExpandState;
    function Probe({ view }: { view: string }) {
      exp = useExpandState(view);
      return null;
    }
    let r!: ReturnType<typeof create>;
    act(() => {
      r = create(<Probe view="o|" />);
    });
    act(() => exp.toggle(IND_ID));
    act(() => exp.toggle(PAIR_ID));
    act(() => exp.toggleMore(`${PAIR_ID}#more`));
    expect([exp.isOpen(IND_ID), exp.isOpen(PAIR_ID), exp.any]).toEqual([
      true,
      true,
      true,
    ]);
    act(() => exp.toggle(IND_ID)); // closes avx512 and its "N more" too
    expect([exp.isOpen(PAIR_ID), exp.moreOpen(`${PAIR_ID}#more`)]).toEqual([
      false,
      false,
    ]);
    act(() => exp.toggle(IND_ID));
    act(() => exp.toggle(PAIR_ID));
    // Another view (a Focus) starts closed; climbing back finds them open.
    act(() => r.update(<Probe view="o|o:inductor" />));
    expect(exp.any).toBe(false);
    act(() => r.update(<Probe view="o|" />));
    expect(exp.isOpen(PAIR_ID)).toBe(true);
    // Owners | Runners closes what the machine listed, and is kept.
    const M = "m:Linux%20x86_64%20avx512";
    act(() => exp.toggle(M));
    act(() => exp.toggle(`${M};o:inductor`));
    act(() => exp.setOpens(M, "label"));
    expect([exp.isOpen(M), exp.isOpen(`${M};o:inductor`)]).toEqual([
      true,
      false,
    ]);
    expect(exp.opens(M)).toBe("label");
    act(() => exp.collapseAll());
    expect([exp.any, exp.opens(M)]).toEqual([false, "label"]);
    act(() => r.unmount());
  });

  // The pair's file, opened in place in the canvas of inductor on avx512.
  const FLEX_ID =
    "o:inductor;m:Linux%20x86_64%20avx512;f:test%2Finductor%2Ftest_flex_attention.py";

  test("a pair's file rows open in place, with Drill in as their key", () => {
    const html = render({ trail: [IND, AVX] }, all);
    expect(html).toContain(
      'aria-label="test_flex_attention.py: open its environments"'
    );
    expect(html).toContain('aria-label="Drill in to test_flex_attention.py"');
    expect(html).not.toMatch(/aria-label="[^"]*: drill in"/);
  });

  test("an open file lists its lanes: environment, workflow, runner-label chips, share of the file", () => {
    const html = render({ trail: [IND, AVX] }, (drill) => (
      <>
        {tree(openAt([FLEX_ID]), FLEX.value)(drill)}
        <i>cases:{String(drill.cases.url)}</i>
      </>
    ));
    const w = words(html);
    expect(html).toContain(
      'aria-label="test_flex_attention.py: close its environments"'
    );
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(1);
    // A lane: what its environment doesn't share with the others, its
    // workflow, then its runner labels with B's hours a day.
    expect(w).toMatch(/Python 3\.11 · GCC 11\.4 · pull mt-l-x86iavx512-\S+ \d/);
    expect(w).toContain("Python 3.14t · Clang 21.1.8 · pull");
    expect(w).toContain("· slow");
    // The whole environment in the name's title; each chip its own.
    expect(html).toMatch(/title="[^"]*Linux 22\.04[^"]*· pull"/);
    expect(html).toMatch(
      /title="mt-l-x86iavx512-16-128: [\d.,K]+ h a day in B"/
    );
    // Values read their share of the file.
    const lanes = levelView(FILE as unknown as CostScope, {
      unit: "hours",
      per: "day",
      pricer: null,
    });
    const top = [...lanes.rows].sort((x, y) => (y.b ?? 0) - (x.b ?? 0))[0];
    const pct = Math.round(((top.b ?? 0) / (lanes.total.b ?? 1)) * 100);
    expect(w).toContain(`${amount("hours", top.b ?? 0)} · ${pct}%`);
    // Lanes have nothing deeper: no caret, no Drill in.
    expect(html.match(/aria-label="Drill in to /g)).toHaveLength(1);
    expect(html).not.toMatch(/aria-label="Python/);
    // Opening asks /scope by=lane only: no /cases (ci.runs).
    expect(w).toContain("cases:null");
    expect(w).not.toContain("Load configurations");
  });

  test("a file's machines open onto the file's lanes there", () => {
    const fileFirst = [IND, FLEX];
    const html = renderToStaticMarkup(
      <SWRConfig
        value={{
          provider: () => new Map(),
          fallback: {
            ...FALLBACK,
            // Machine-shaped numbers for inductor's file; words are read.
            [scope(fileFirst, "m")]: { ...(OWNER as object), trail: fileFirst },
            [scope([IND, FLEX, AVX], "lane")]: {
              ...(FILE as object),
              trail: [IND, FLEX, AVX],
            },
          },
        }}
      >
        <Inner
          query={{ ...QUERY, trail: fileFirst }}
          part={tree(
            openAt([
              "o:inductor;f:test%2Finductor%2Ftest_flex_attention.py;m:Linux%20x86_64%20avx512",
            ]),
            AVX.value
          )}
        />
      </SWRConfig>
    );
    expect(html).toContain(
      'aria-label="Linux x86_64 avx512: close its environments"'
    );
    expect(html).toContain('aria-label="Drill in to Linux x86_64 avx512"');
    expect(words(html)).toContain("Python 3.11 · GCC 11.4 · pull");
  });

  test("clicking a file row opens it in place; Drill in moves to the file view", () => {
    const toggled: string[] = [];
    const exp = { ...openAt([]), toggle: (id: string) => toggled.push(id) };
    const patches: Partial<DrillQuery>[] = [];
    // A second renderer beside the SSR ones, and emotion with no document
    // to hand a ref to: React's two dev warnings about that, nothing else.
    const error = console.error;
    const quiet = jest.spyOn(console, "error").mockImplementation((...a) => {
      const m = String(a[0]);
      if (/multiple renderers|cannot be given refs/.test(m)) return;
      error(...a);
    });
    try {
      let r!: ReturnType<typeof create>;
      act(() => {
        r = create(
          <SWRConfig
            value={{
              provider: () => new Map(),
              fallback: FALLBACK,
              revalidateOnMount: false,
            }}
          >
            <Inner
              query={{ ...QUERY, trail: [IND, AVX] }}
              part={tree(exp, FLEX.value)}
              onQueryChange={(p) => patches.push(p)}
            />
          </SWRConfig>
        );
      });
      const host = (label: string) =>
        r.root.findAll(
          (n) => typeof n.type === "string" && n.props["aria-label"] === label
        );
      const [row] = host("test_flex_attention.py: open its environments");
      const [key] = host("Drill in to test_flex_attention.py");
      expect([row === undefined, key === undefined]).toEqual([false, false]);
      act(() => row.props.onClick({ target: { closest: () => null } }));
      expect(toggled).toEqual([FLEX_ID]);
      expect(patches).toEqual([]); // the trail stays
      act(() => key.props.onClick({}));
      expect(patches).toEqual([
        { trail: [IND, AVX, FLEX], tests: false, cfg: null, cases: null },
      ]);
      act(() => r.unmount());
    } finally {
      quiet.mockRestore();
    }
  });
});
