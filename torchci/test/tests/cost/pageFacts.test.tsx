// The facts row under the cost page's title
// (components/tests/cost/PageFacts), rendered on the server: its pills in
// order over the last 28 whole days of the root trend, a light caption with
// that window and the signals' that says A/B moves neither, $ with a stub
// pricer and the FAKE weekly rates, and the PR signals of the 7-day answer.

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
// pushes to main) and 1.5K h on a label no rates file prices (none on
// pushes to main), 100 pushes a day; the owner cells 30 h of inductor to
// 10 h unattributed a day.
const DAYS = Array.from({ length: 36 }, (_, i) => addDays("2026-10-15", i));
function trendOf(
  first = 0,
  unpriced: { hours: number; main: number } = { hours: 1_500, main: 0 }
): CostTrend {
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
            [i, 1, unpriced.hours, unpriced.main],
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
// The caption's words.
function caption(markup: string): string {
  const m = markup.match(
    /MuiTypography-caption[^>]*>([\s\S]*?)<\/span><\/section>/
  );
  return m === null ? "" : words(`<x>${m[1]}</x>`);
}
// Every title attribute, unescaped.
function titles(markup: string): string[] {
  return [...markup.matchAll(/title="([^"]*)"/g)].map((m) =>
    m[1]
      .replace(/&#x27;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
  );
}

const PER_DAY = 31_500;
const WINDOW = "Last 28 days";

describe("page facts row", () => {
  test("the pills in order over the last 28 days, then the PR signals", () => {
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
          `${WINDOW} · signals last 7 days · A/B picks don't apply`,
        ].join(" ")
      );
    }
    expect(hoursLabel(PER_DAY * 365)).toBe("11.5M");
  });

  test("the caption: the figures' window and the signals', A/B picks don't apply, kept whole when it wraps", () => {
    const html = render({});
    expect(caption(html)).toBe(
      `${WINDOW} · signals last 7 days · A/B picks don't apply`
    );
    // Light, small, at the row's end; each part one unbroken run.
    expect(html).toMatch(
      /MuiTypography-caption[^"]*" title="Whole days only; the A\/B picks below don&#x27;t change these"/
    );
    expect(html).toContain(
      `<span class="MuiBox-root css-epvm6">${WINDOW}</span> · <span class="MuiBox-root css-epvm6">signals last 7 days · A/B picks don&#x27;t apply</span>`
    );
    expect(html).toMatch(/\.css-epvm6\{white-space:nowrap;\}/);
    expect(html).toMatch(/margin-left:auto;/);
    // A 1-day signals window is "day", not "1 days".
    const oneDay = render({
      runnerHours: { ...runnerHours, window: "1d" } as RunnerHours,
    });
    expect(caption(oneDay)).toBe(
      `${WINDOW} · signals last day · A/B picks don't apply`
    );
    expect(titles(oneDay)).toContain(
      "Last day, Nov 19\nMedian pull run time on pushes to main, queue included\np90 2.0 h · 300 runs"
    );
    expect(titles(oneDay).join("\n")).not.toContain("1 days");
    // Without the signals, the window alone.
    expect(caption(render({ runnerHours: undefined }))).toBe(
      `${WINDOW} · A/B picks don't apply`
    );
  });

  test("each pill's title says how it is counted, in at most three lines", () => {
    const html = render({});
    const t = titles(html);
    // The row has no title of its own: the caption says the window.
    expect(html).not.toMatch(/aria-label="Page facts" title=/);
    expect(t).toContain(
      `Per day × 365; ${hoursLabel((PER_DAY * 365) / 12)} runner-hours a month`
    );
    expect(t).toContain(
      "Daily mean of Oct 22 – Nov 18 (28 days), weekends included"
    );
    expect(t).toContain("Runner-hours of pushes to main ÷ 2,800 pushes");
    expect(t).toContain(
      "Share of runner-hours in test files with an owner in today's owners list"
    );
    for (const title of t)
      expect(title.split("\n").length).toBeLessThanOrEqual(3);
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
    expect(caption(late)).toBe(
      "Last 21 days · signals last 7 days · A/B picks don't apply"
    );
    expect(titles(late)).toContain(
      "Daily mean of Oct 29 – Nov 18 (21 days), weekends included"
    );
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
    expect(titles(html)).toContain("pull, trunk, inductor, slow");
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
    // 1.5K of 31.5K hours a day have no rate; none of the pushes' hours.
    expect(titles(full)).toContain(
      `Per day × 365; ${amount(
        "usd",
        (60_000 * 365) / 12
      )} a month\n5% of hours unpriced ($0)`
    );
    expect(titles(full)).toContain(
      "Daily mean of Oct 22 – Nov 18 (28 days), weekends included\n5% of hours unpriced ($0)"
    );
    expect(titles(full)).toContain("$ of pushes to main ÷ 2,800 pushes");
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
      `Per day × 365; ≈${amount(
        "usd",
        (60_000 * 365) / 12
      )} a month\n25 of 28 days priced\n5% of priced days' hours unpriced ($0)`
    );
    const none = render({
      unit: "usd",
      pricer: stubPricer(["2026-10-01", "2026-11-30"]),
    });
    expect(words(none)).toContain(
      "Annualized no rates Per day no rates Per commit no rates Attributed to owners 75%"
    );
  });

  test("$: hours without a rate said from 0.5% of the window's, per commit by the pushes' hours", () => {
    const say = (unpriced: { hours: number; main: number }) =>
      titles(
        render({
          trend: trendOf(0, unpriced),
          unit: "usd",
          pricer: stubPricer(),
        })
      ).join("\n");
    // 150 of 30,150 h: under 0.5%, unsaid.
    expect(say({ hours: 150, main: 0 })).not.toContain("unpriced");
    // 200 of 30,200 h: said, under 1%.
    expect(say({ hours: 200, main: 0 })).toContain(
      "<1% of hours unpriced ($0)"
    );
    // 500 of the pushes' 2,500 h: per commit's own share.
    const t = say({ hours: 500, main: 500 });
    expect(t).toContain(
      "$ of pushes to main ÷ 2,800 pushes\n20% of hours unpriced ($0)"
    );
    expect(t).toContain("weekends included\n2% of hours unpriced ($0)");
    // Hours price nothing.
    expect(
      titles(render({ trend: trendOf(0, { hours: 500, main: 500 }) })).join(
        "\n"
      )
    ).not.toContain("unpriced");
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
    for (const t of titles(html)) {
      expect(t.split("\n").length).toBeLessThanOrEqual(3);
    }
  });
});
