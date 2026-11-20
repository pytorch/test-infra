// The facts row under the V2 page's title (components/tests/cost/PageFacts),
// rendered on the server: V1's pills and order over the last 28 whole days
// of the root trend, the window in the row's title only, $ with a stub
// pricer and the FAKE weekly rates, and the PR signals of the 7-day answer
// moved here from the drill head.

import { createTheme, ThemeProvider } from "@mui/material/styles";
import PageFacts, {
  type PageFactsProps,
} from "components/tests/cost/PageFacts";
import {
  addDays,
  type Day,
  type PieceRate,
  type Pricer,
  type RateDayKind,
} from "lib/api/tests/cost/contracts";
import type { CostTrend, RunnerHours } from "lib/api/tests/cost/types";
import { amount } from "lib/tests/cost/drill";
import { hoursLabel } from "lib/tests/cost/query";
import { makePricer, parseRatesFiles } from "lib/tests/cost/ratePeriods";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

const LF = "lf-l-x86iavx512-16-128";
// Oct 15 – Nov 19, Nov 19 still filling: 30K h a day on LF (2K of them on
// pushes to main) and 1.5K h on a label no rates file prices, 100 pushes a
// day; the owner cells 30 h of inductor to 10 h unattributed a day.
const DAYS = Array.from({ length: 36 }, (_, i) => addDays("2026-10-15", i));
function trendOf(first = 0): CostTrend {
  const days = DAYS.slice(first);
  return {
    repo: "pytorch/pytorch",
    rollup: "day",
    workflows: [],
    start: DAYS[0],
    end: "2026-11-20",
    periods: DAYS,
    owners: ["inductor", "unattributed:no_test_reports"],
    labels: [LF, "zz-unpriced"],
    cells: days.flatMap(
      (d) =>
        [
          [DAYS.indexOf(d), 0, 0, 30, 0],
          [DAYS.indexOf(d), 1, 0, 10, 0],
        ] as CostTrend["cells"]
    ),
    daily: {
      start: "2026-01-01",
      days,
      filling: ["2026-11-19"],
      pushes: days.map(() => 100),
      cells: days.flatMap(
        (_, i) =>
          [
            [i, 0, 30_000, 2_000],
            [i, 1, 1_500, 0],
          ] as CostTrend["daily"]["cells"]
      ),
    },
    query_duration_ms: 1,
  };
}

const runnerHours = {
  window: "7d",
  end: "2026-11-20T00:00:00.000Z",
  time_to_signal: [
    {
      value: "pr_update",
      label: "PR update signals",
      description: "",
      workflow: "pull",
      runs: 300,
      p50_seconds: 4320,
      p90_seconds: 7200,
    },
    {
      value: "pr_merge",
      label: "PR merge signals",
      description: "",
      workflow: "trunk",
      runs: 0,
      p50_seconds: null,
      p90_seconds: null,
    },
  ],
} as unknown as RunnerHours;

// $2/h on LF, nothing on other labels; days in gap have no rates.
function stubPricer(gap?: [Day, Day]): Pricer {
  const kind = (day: Day): RateDayKind =>
    gap && day >= gap[0] && day <= gap[1] ? "gap" : "final";
  const rate = (label: string, day: Day) =>
    kind(day) === "gap" || label !== LF ? null : 2;
  return {
    set: {
      file: "stub.json",
      metaFile: null,
      basis: null,
      generatedAt: null,
      legacy: false,
      periods: [],
    },
    today: "2026-11-20",
    rate,
    piece: (): PieceRate => ({
      rate: 2,
      priced: 1,
      exact: true,
      borrowed: false,
    }),
    dayKind: kind,
    segments: () => [],
    coverageLine: () => null,
  };
}

function render(
  props: Partial<PageFactsProps>,
  mode: "light" | "dark" = "light"
) {
  return renderToStaticMarkup(
    <ThemeProvider theme={createTheme({ palette: { mode } })}>
      <PageFacts
        trend={trendOf()}
        scope="all workflows"
        unit="hours"
        pricer={null}
        runnerHours={runnerHours}
        {...props}
      />
    </ThemeProvider>
  );
}

function words(markup: string): string {
  return markup
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
// Every title attribute, unescaped.
function titles(markup: string): string[] {
  return [...markup.matchAll(/title="([^"]*)"/g)].map((m) =>
    m[1].replace(/&#x27;/g, "'").replace(/&amp;/g, "&")
  );
}

const PER_DAY = 31_500;
const WINDOW = "Last 28 days, Oct 22 – Nov 18";

describe("page facts row", () => {
  test("V1's pills in V1's order over the last 28 days, then the PR signals", () => {
    for (const mode of ["light", "dark"] as const) {
      const html = render({}, mode);
      expect(words(html)).toBe(
        [
          "Across all workflows",
          `Annualized ${hoursLabel(PER_DAY * 365)} runner-hours a year`,
          `Per day ${hoursLabel(PER_DAY)} runner-hours`,
          `Per commit ${amount("hours", 20)}`,
          "Attributed to owners 75%",
          "PR update signals 1.2 h",
          "PR merge signals none",
        ].join(" ")
      );
    }
    expect(hoursLabel(PER_DAY * 365)).toBe("11.5M");
  });

  test("the window once, in titles: the row's, and the pills that say more", () => {
    const html = render({});
    expect(words(html)).not.toContain("Last 28 days");
    const t = titles(html);
    // The row's own title, which Per day takes.
    expect(html).toMatch(
      /aria-label="Page facts" title="Last 28 days, Oct 22 – Nov 18"/
    );
    expect(t).toContain(
      `${WINDOW}\n${hoursLabel((PER_DAY * 365) / 12)} runner-hours a month`
    );
    expect(t).toContain(
      `${WINDOW}\nRunner-hours of pushes to main ÷ 2,800 pushes`
    );
    expect(t).toContain(
      `${WINDOW}\nShare of runner-hours in test files with an owner`
    );
    // The PR signals say their own 7 days.
    expect(t).toContain(
      "Last 7 days, Nov 13–19\nMedian pull run time on pushes to main, queue included\np90 2.0 h · 300 runs"
    );
    expect(t).toContain(
      "Last 7 days, Nov 13–19\nMedian trunk run time on pushes to main, queue included"
    );
  });

  test("fewer days while the data holds fewer; dots while the scope's trend loads", () => {
    const late = render({ trend: trendOf(14) });
    expect(late).toContain('title="Last 21 days, Oct 29 – Nov 18"');
    expect(words(late)).toContain(
      `Per day ${hoursLabel(PER_DAY)} runner-hours`
    );
    const loading = words(render({ trend: undefined, runnerHours: undefined }));
    expect(loading).toBe(
      "Across all workflows Annualized … Per day … Per commit … Attributed to owners …"
    );
  });

  test("a scope by name, a custom scope's workflows in its title", () => {
    const html = render({
      scope: "pull + trunk + 2 more",
      scopeDetail: "pull, trunk, inductor, slow",
    });
    expect(words(html)).toContain("Across pull + trunk + 2 more");
    expect(titles(html)).toContain(`${WINDOW}\npull, trunk, inductor, slow`);
  });

  test("$ with a stub pricer: each figure in $, ≈ and priced days for a gap, no rates for none", () => {
    const full = render({ unit: "usd", pricer: stubPricer() });
    expect(words(full)).toContain(
      [
        `Annualized ${amount("usd", 60_000 * 365)} a year`,
        `Per day ${amount("usd", 60_000)}`,
        `Per commit ${amount("usd", 40)}`,
        "Attributed to owners 75%",
      ].join(" ")
    );
    expect(titles(full)).toContain(
      `${WINDOW}\n${amount("usd", (60_000 * 365) / 12)} a month`
    );
    // No rates from Nov 16: Oct 22 – Nov 15 priced, 25 of 28 days.
    const gap = render({
      unit: "usd",
      pricer: stubPricer(["2026-11-16", "2026-11-30"]),
    });
    expect(words(gap)).toContain(
      `Annualized ≈${amount("usd", 60_000 * 365)} a year Per day ≈${amount(
        "usd",
        60_000
      )} Per commit ≈${amount("usd", 40)}`
    );
    expect(titles(gap)).toContain(
      `${WINDOW}\n≈${amount(
        "usd",
        (60_000 * 365) / 12
      )} a month\n25 of 28 days priced`
    );
    const none = render({
      unit: "usd",
      pricer: stubPricer(["2026-10-01", "2026-11-30"]),
    });
    expect(words(none)).toContain(
      "Annualized no rates Per day no rates Per commit no rates Attributed to owners 75%"
    );
  });

  test("$ with the FAKE weekly rates: the days after its last week borrow it (≈)", () => {
    const file = (name: string) => ({
      name,
      text: readFileSync(join(__dirname, name), "utf8"),
    });
    const pricer = makePricer(
      parseRatesFiles([
        file("rates_FAKE_weekly.json"),
        file("rates_FAKE_weekly.meta.json"),
      ]),
      "2026-11-20"
    );
    const html = render({ unit: "usd", pricer });
    expect(words(html)).toMatch(
      /Annualized ≈\$[\d.]+[KM] a year Per day ≈\$[\d.]+K Per commit ≈\$[\d.]+ /
    );
    expect(titles(html).some((t) => /\n≈ priced with .* rates/.test(t))).toBe(
      true
    );
  });
});
