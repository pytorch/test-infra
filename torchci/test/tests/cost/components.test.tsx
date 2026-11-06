// The cost panel's components drawn from the example JSONs beside this
// file and read as words: the facts' row in $, the panel's line about the
// file, the owner chart, the runners drawer and the machine key say what
// rates.ts works out; at $1 an hour they say the runner-hours; and the file
// format the panel shows is a file the page reads.

import CostFacts from "components/tests/cost/CostFacts";
import CostMachineKey from "components/tests/cost/CostMachineKey";
import CostPanel from "components/tests/cost/CostPanel";
import MachineKey from "components/tests/cost/MachineKey";
import OwnerChart from "components/tests/cost/OwnerChart";
import RatesFormat from "components/tests/cost/RatesFormat";
import RunnersDrawer from "components/tests/cost/RunnersDrawer";
import { RunnerHoursSchema } from "lib/api/tests/cost/types";
import {
  costFacts,
  costMark,
  parseRates,
  priceableRunners,
  pricedRunnerHours,
  type RatesFile,
  withRate,
} from "lib/tests/cost/rates";
import {
  computeView,
  factsOf,
  ownerRows,
  type PreparedHours,
  prepareRunnerHours,
} from "lib/tests/cost/runnerHours";
import { renderToStaticMarkup } from "react-dom/server";
import ANSWER_JSON from "./answer.json";
import RATES_JSON from "./rates.json";

const answer = RunnerHoursSchema.parse(ANSWER_JSON);
const prepared = prepareRunnerHours(answer);
const rates = parseRates(JSON.stringify(RATES_JSON), "rates.json");
// Every runner of the window at $1 an hour.
const one = parseRates(
  JSON.stringify(
    Object.fromEntries(priceableRunners(prepared).map((r) => [r.label, 1]))
  ),
  "one.json"
);
const NONE = { workflows: [], owners: [], machines: [] };
const noop = () => {};

// A rendering without the style tags emotion writes beside it.
function unstyled(markup: string): string {
  return markup.replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, "");
}

function decoded(html: string): string {
  return html
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// The words of a rendering, each element's apart.
function words(markup: string): string {
  return decoded(
    unstyled(markup)
      .replace(/<wbr\/?>/g, "")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

// A table's rows as the words of their cells.
function tableRows(markup: string): string[][] {
  return Array.from(
    unstyled(markup).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g),
    ([, row]) =>
      Array.from(
        row.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g),
        ([, cell]) => words(cell)
      )
  );
}

// The tooltips a rendering carries as title attributes.
function titles(markup: string): string[] {
  return Array.from(unstyled(markup).matchAll(/ title="([^"]*)"/g), ([, t]) =>
    decoded(t)
  );
}

// The shares a rendering states, in order.
function shares(markup: string): string[] {
  return words(markup).match(/[<>]?\d+%/g) ?? [];
}

const priced = (r: RatesFile) => pricedRunnerHours(prepared, r);

function facts(r: RatesFile | null): string {
  const view = computeView(prepared, NONE);
  let cost;
  if (r !== null) {
    const p = priced(r);
    cost = { ...costFacts(p, computeView(p, NONE), answer.days), file: r.file };
  }
  return words(
    renderToStaticMarkup(
      <CostFacts
        facts={factsOf(prepared, view, answer.days)}
        dates="Oct 29 – Nov 4"
        loading={false}
        scope={null}
        signals={answer.time_to_signal}
        onClearScope={noop}
        cost={cost}
      />
    )
  );
}

// The runners drawer of the owner chart's row by its key.
function drawer(p: PreparedHours, key: string): string {
  const view = computeView(p, NONE);
  return renderToStaticMarkup(
    <RunnersDrawer
      prepared={p}
      view={view}
      row={ownerRows(view, false, "grouped").find((r) => r.key === key) ?? null}
      ratesFile={p.unit === "cost" ? "rates.json" : null}
      onClose={noop}
    />
  );
}

function costKey(p: PreparedHours): string {
  return renderToStaticMarkup(
    <CostMachineKey
      prepared={p}
      view={computeView(p, NONE)}
      onToggleMachines={noop}
      onClearMachines={noop}
    />
  );
}

function chart(p: PreparedHours): string {
  return renderToStaticMarkup(
    <OwnerChart
      repo="pytorch/pytorch"
      prepared={p}
      view={computeView(p, NONE)}
      presets={answer.workflow_presets}
      scope={[]}
      split
      loading={false}
      dates="Oct 29 – Nov 4"
      method={answer.method}
      onScopeChange={noop}
      onSplitChange={noop}
      onToggleOwners={noop}
      onToggleMachines={noop}
      onClearHighlight={noop}
      onClearMachines={noop}
      onOpenRunners={p.unit === "cost" ? noop : undefined}
    />
  );
}

// The owner chart's rows as it writes them: label, amount and share.
function chartRows(p: PreparedHours): string[][] {
  const text = words(chart(p));
  return ownerRows(computeView(p, NONE), false, "grouped").map((r) => {
    const [, amount, share] =
      text.match(new RegExp(`\\b${r.label} (\\S+(?: h)?) (\\S+%)`)) ?? [];
    return [r.label, amount, share];
  });
}

function panel(r: RatesFile | null): string {
  return words(
    renderToStaticMarkup(
      <CostPanel
        prepared={prepared}
        rates={r}
        error={null}
        onFile={noop}
        onClear={noop}
        onDismissError={noop}
        onUndoEdits={noop}
        chart={(frame) => frame.banner}
      />
    )
  );
}

describe("CostFacts", () => {
  test("with a rates file, a second row in $: the scope a year and a day, and the share of its runner-hours priced", () => {
    const text = facts(rates);
    expect(text).toContain("Annualized 30.1K runner-hours a year");
    // $455.25 over 7 days: $65 a day, $23.7K a year; 472.4 of 578 h priced.
    expect(text).toContain("Annualized $23.7K a year");
    expect(text).toContain("Per day $65");
    expect(text).toContain("Priced 82% of runner-hours");
  });

  test("without one, no row in $", () => {
    expect(facts(null)).not.toMatch(/\$|Priced/);
  });

  test("at $1 an hour, the row in $ says the runner-hours row's numbers, all priced", () => {
    const text = facts(one);
    const hours = (label: string) =>
      text.match(new RegExp(`${label} (\\S+) runner-hours`))?.[1];
    const dollars = (label: string) =>
      text.match(new RegExp(`${label} \\$(\\S+)`))?.[1];
    for (const label of ["Annualized", "Per day"]) {
      expect(hours(label)).toBeDefined();
      expect(dollars(label)).toBe(hours(label));
    }
    expect(text).toContain("Priced 100% of runner-hours");
  });
});

describe("CostPanel", () => {
  test("asks for a file until one is added", () => {
    const text = panel(null);
    expect(text).toContain("Apply your runner rates to see cost by owner");
    expect(text).toContain("Choose rates file…");
  });

  test("names the file, its notes, its edits, the runners it leaves without a rate and its labels that did not run", () => {
    const text = panel(rates);
    expect(text).toContain("rates.json (in this tab only)");
    expect(text).toContain("valid from 2026-10-01");
    expect(text).toContain("example rates for tests, not real prices");
    expect(text).toContain("budget $9.1K a year");
    expect(text).toContain("2 runners have no rate");
    expect(text).toContain("1 label didn't run here");
    expect(text).not.toContain("edited");
    // Priced in the key, A10G's runner leaves the runners without one.
    const edited = panel(withRate(rates, "mt-l-x86aavx2-11-41-a10g", 1));
    expect(edited).toContain("1 edited ( Undo )");
    expect(edited).toContain("1 runner has no rate");
  });
});

describe("RunnersDrawer", () => {
  test("an owner's machines and runners with their $/h, cost and share, and the runners with no rate", () => {
    const markup = drawer(priced(rates), "inductor");
    // $150 + $30 of $455.25; 80 of its 260 h on A10G have no rate.
    expect(words(markup)).toContain(
      "$180 · 40% of the cost · 260 h, 31% with no rate · in all workflows"
    );
    expect(tableRows(markup)).toEqual([
      ["Machine · runner", "Runner-hours", "$/h", "Cost", "Share"],
      ["NVIDIA L4", "120 h", "$1.25/h", "$150", "83%"],
      ["mt-l-x86aavx2-11-41-l4", "120 h", "$1.25/h", "$150", "100%"],
      ["Linux x86_64 avx512", "60 h", "$0.50/h", "$30", "17%"],
      ["mt-l-x86iavx512-16-128", "60 h", "$0.50/h", "$30", "100%"],
      ["NVIDIA A10G", "80 h", "—", "no rate", "—"],
      ["mt-l-x86aavx2-11-41-a10g", "80 h", "no rate", "—", "—"],
    ]);
    expect(words(markup)).toContain(
      "No rate in rates.json: 1 of inductor's runner, 80 h (31% of its runner-hours)."
    );
  });

  test("a machine whose runners' rates differ is their average over its priced hours, marked ~", () => {
    // inductor ran L4 and avx512 on the mt- runners, distributed on the lf-
    // ones; folded together, as under "N more owners", each machine has two.
    const p = priced(rates);
    const view = computeView(p, NONE);
    const markup = renderToStaticMarkup(
      <RunnersDrawer
        prepared={p}
        view={view}
        row={{
          key: "more",
          label: "2 more owners",
          owners: ["inductor", "distributed"],
          hours: 180 + 105,
          kind: "more",
        }}
        ratesFile="rates.json"
        onClose={noop}
      />
    );
    const rows = tableRows(markup);
    // 120 h × $1.25 + 50 h × $1.5 over 170 h; 60 h × $0.5 + 40 h × $0.75
    // over 100 h.
    expect(rows.find((r) => r[0] === "NVIDIA L4")).toEqual([
      "NVIDIA L4",
      "170 h",
      "~$1.32/h",
      "$225",
      "79%",
    ]);
    expect(rows.find((r) => r[0] === "Linux x86_64 avx512")).toEqual([
      "Linux x86_64 avx512",
      "100 h",
      "~$0.60/h",
      "$60",
      "21%",
    ]);
  });

  test("a bucket's estimated machine is priced at its runner's rate; Unknown machine has none", () => {
    const rows = tableRows(drawer(priced(rates), "unattributed"));
    // $80 of the bucket's $96.25.
    expect(rows.find((r) => r[0].startsWith("AMD Instinct MI355X"))).toEqual([
      "AMD Instinct MI355X · 100% est.",
      "40 h",
      "$2.00/h",
      "$80",
      "83%",
    ]);
    expect(rows.find((r) => r[0] === "Unknown machine")).toEqual([
      "Unknown machine",
      "26 h",
      "—",
      "no rate",
      "—",
    ]);
  });

  test.each(["inductor", "dynamo", "distributed", "unattributed"])(
    "at $1 an hour, %s's machines and runners cost their runner-hours at $1.00/h, with the runner-hours drawer's shares",
    (key) => {
      const markup = drawer(priced(one), key);
      const cost = tableRows(markup);
      const hours = tableRows(drawer(prepared, key));
      expect(hours[0]).toEqual(["Machine · runner", "Runner-hours", "Share"]);
      expect(
        cost.slice(1).map(([name, h, , , share]) => [name, h, share])
      ).toEqual(hours.slice(1));
      for (const [, h, rate, dollars] of cost.slice(1)) {
        expect(rate).toBe("$1.00/h");
        expect(dollars).toBe(`$${h.replace(/ h$/, "")}`);
      }
      expect(words(markup)).not.toContain("No rate");
    }
  );
});

describe("CostMachineKey", () => {
  test("each machine's $ and runner-hours, its $/h (~ where its runners' rates differ, $0.00 where its rate is $0, — where it has none) and share of the $", () => {
    const markup = costKey(priced(rates));
    expect(titles(markup)).toEqual([
      "Linux x86_64 avx512: $120 · 220 h",
      "NVIDIA L4: $231 · 175 h",
      "NVIDIA A10G: $0 · 80 h",
      "AMD Instinct MI355X: $80 · 40 h",
      "Windows x86_64 avx512: $24 · 30 h",
      "Apple M1: $0 · 7 h",
      "Unknown machine: $0 · 26 h",
    ]);
    const text = words(markup);
    expect(text).toContain("· share of $455");
    // 120 h at $0.50 and 40 h at $0.75 + 20 h at $0.50 over 220 h.
    expect(text).toContain("Linux x86_64 avx512 ~$0.545/h 26% $120");
    expect(text).toContain("NVIDIA L4 ~$1.32/h 51% $231");
    expect(text).toContain("NVIDIA A10G — no rate 80 h");
    expect(text).toContain("AMD Instinct MI355X $2.00/h 18% $80");
    expect(text).toContain("Apple M1 $0.00/h 0% $0");
    expect(text).toContain("Unknown machine no rate 26 h");
    expect(text).toContain(
      "No rate: 106 h (18% of runner-hours) on 2 runners, largest mt-l-x86aavx2-11-41-a10g (80 h), linux.idc.xpu (26 h)."
    );
  });

  test("at $1 an hour, each machine's $ is its runner-hours, at $1.00/h, with the runner-hours key's shares", () => {
    const markup = costKey(priced(one));
    const hoursKey = renderToStaticMarkup(
      <MachineKey
        prepared={prepared}
        view={computeView(prepared, NONE)}
        onToggleMachines={noop}
        onClearMachines={noop}
      />
    );
    // "NVIDIA L4: $175 · 175 h" is the runner-hours key's "NVIDIA L4: 175 h".
    expect(
      titles(markup).map((t) => {
        const [, name, dollars, hours] =
          t.match(/^(.*): \$(\S+) · (\S+) h$/) ?? [];
        expect(dollars).toBe(hours);
        return `${name}: ${hours} h`;
      })
    ).toEqual(titles(hoursKey));
    expect(shares(markup)).toEqual(shares(hoursKey));
    expect(words(markup)).toContain("· share of $578");
    expect(words(markup).match(/\$\d[.\d]*\/h/g)).toEqual(
      Array(6).fill("$1.00/h")
    );
    expect(words(markup)).not.toContain("No rate");
  });
});

describe("OwnerChart", () => {
  test("in $, owners by their cost with its share, the unattributed hours last, and each bar marked at its priced runner-hours at the scope's average $/h", () => {
    const p = priced(rates);
    expect(chartRows(p)).toEqual([
      ["inductor", "$180", "40%"],
      ["distributed", "$105", "23%"],
      ["dynamo", "$74", "16%"],
      ["Unattributed", "$96", "21%"],
    ]);
    // The axis runs to $200; the marks are where the stylesheet puts them.
    const markup = chart(p);
    expect(words(markup)).toContain("$455 in all workflows");
    for (const row of ownerRows(computeView(p, NONE), false, "grouped")) {
      const mark = costMark(computeView(p, NONE), row.owners);
      expect(markup).toContain(`left:${(100 * mark) / 200}%`);
    }
  });

  test("at $1 an hour, the rows say the runner-hours chart's", () => {
    expect(
      chartRows(priced(one)).map(([label, amount, share]) => [
        label,
        `${amount.replace(/^\$/, "")} h`,
        share,
      ])
    ).toEqual(chartRows(prepared));
    expect(words(chart(priced(one)))).toContain("$578 in all workflows");
  });
});

describe("RatesFormat", () => {
  test("the formats the panel shows are files the page reads, keyed by the window's largest runners", () => {
    const examples = priceableRunners(prepared)
      .slice(0, 2)
      .map((r) => r.label);
    const files = Array.from(
      unstyled(
        renderToStaticMarkup(
          <RatesFormat exampleLabels={examples} runners={9} />
        )
      ).matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/g),
      ([, json]) => parseRates(decoded(json), "example.json")
    );
    expect(files.map((f) => Object.keys(f.rates))).toEqual([
      examples,
      examples,
    ]);
    expect(files.map((f) => [f.validFrom, f.basis, f.budget])).toEqual([
      [null, null, null],
      [
        "2026-10-01",
        "how the rates were made",
        { annual: 1200000, owners: { inductor: 300000 } },
      ],
    ]);
  });
});
