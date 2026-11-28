// The rate strip, the rates control and the format popover, from the FAKE weekly
// fixtures beside this file: where segments sit on the bars' day axis, what
// they say, and the words each component renders (SSR; no jsdom here).

import RatesControl from "components/tests/cost/rates/RatesControl";
import RatesFormatPeriods, {
  formatExamples,
} from "components/tests/cost/rates/RatesFormatPeriods";
import RateStrip, {
  fitLabel,
  stripModel,
} from "components/tests/cost/rates/RateStrip";
import {
  addDays,
  type Day,
  type DayRange,
  type StripGeometry,
} from "lib/api/tests/cost/contracts";
import { rateLabel } from "lib/tests/cost/query";
import {
  makePricer,
  parseRatesFiles,
  periodTotals,
} from "lib/tests/cost/ratePeriods";
import { RATES_FILE_URL } from "lib/tests/cost/rates";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

const TODAY = "2026-11-19";
const file = (name: string) => ({
  name,
  text: readFileSync(join(__dirname, name), "utf8"),
});
const WEEKLY = file("rates_FAKE_weekly.json");
const META = file("rates_FAKE_weekly.meta.json");
const GAP = file("rates_FAKE_weekly_gap.json");
const weeklyJson = JSON.parse(WEEKLY.text);
const LABEL = "mt-l-x86iavx512-16-128";
const rateIn = (period: number) => weeklyJson.periods[period].rates[LABEL];
const noop = () => {};

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

// Data from Oct 29 (the data start): 1,000 h a day on LABEL and 100 h on a
// label no file prices.
const DATA_FROM = "2026-10-29";
function priceSpanOf(pricer: ReturnType<typeof makePricer>) {
  return (range: DayRange) => {
    let usd = 0;
    let hours = 0;
    let unpriced = 0;
    for (let d = range.from; d <= range.to; d = addDays(d, 1)) {
      if (d < DATA_FROM || d >= TODAY) continue;
      for (const [label, h] of [
        [LABEL, 1000],
        ["linux.unpriced", 100],
      ] as const) {
        hours += h;
        const r = pricer.rate(label, d);
        if (r === null) unpriced += h;
        else usd += h * r;
      }
    }
    return { usd, hours, unpriced };
  };
}

function dayBars(from: Day, n: number): StripGeometry["bars"] {
  return Array.from({ length: n }, (_, i) => ({
    start: addDays(from, i),
    days: 1,
  }));
}

describe("the rate strip", () => {
  const weekly = makePricer(parseRatesFiles([WEEKLY, META]));
  // 42 day bars, Oct 8 – Nov 18.
  const bars = dayBars("2026-10-08", 42);
  const geometry = {
    bars,
    last: "2026-11-18",
    priceSpan: priceSpanOf(weekly),
  };

  test("day bars: segments are the file's periods from the data start, on the bars' axis", () => {
    const model = stripModel(weekly, geometry);
    expect(model.map((s) => [s.from, s.to, s.kind, s.period])).toEqual([
      ["2026-10-29", "2026-11-01", "final", 1],
      ["2026-11-02", "2026-11-08", "final", 2],
      ["2026-11-09", "2026-11-15", "provisional", 3],
      ["2026-11-16", "2026-11-18", "gap", null],
    ]);
    expect(model[0].left).toBeCloseTo(21 / 42, 10);
    expect(model[1].left).toBeCloseTo(25 / 42, 10);
    expect(model[1].width).toBeCloseTo(7 / 42, 10);
    expect(model[3].left + model[3].width).toBeCloseTo(1, 10);
    // $/h = $ ÷ priced hours of the bars' scope: the unpriced label is left out.
    expect(model[1].rate).toBeCloseTo(rateIn(2), 10);
    expect(model[1].labels).toEqual([
      `Nov 2–8 · ${rateLabel(rateIn(2))}`,
      rateLabel(rateIn(2)),
      "Nov 2",
    ]);
    expect(model[2].labels[0]).toBe(`Nov 9–15 · ${rateLabel(rateIn(3))} prov.`);
    expect(model[2].title).toBe("Nov 9–15 rates · provisional");
    expect(model[2].lines).toEqual([
      "From rates_FAKE_weekly.json · made from Nov 9–13",
      `${rateLabel(rateIn(3))} over 7K h in view`,
      "700 h on labels without a rate",
    ]);
    // The days after the file's end are a gap like a hole: no rates, not
    // even the last period's.
    expect([model[3].rate, model[3].usd]).toEqual([null, 0]);
    expect(model[3].labels).toEqual(["no rates"]);
    expect(model[3].title).toBe("No rates · Nov 16–18");
    expect(model[3].lines).toEqual([
      "Not in the rates file: only the days it lists are priced.",
      "3.3K h unpriced, left out of $",
    ]);
  });

  test("week bars: a segment per bar, the data start and `last` mid-bar", () => {
    const weeks = ["2026-10-26", "2026-11-02", "2026-11-09", "2026-11-16"].map(
      (start) => ({ start, days: 7 })
    );
    const model = stripModel(weekly, { ...geometry, bars: weeks });
    const expected = [
      [3 / 7 / 4, 4 / 7 / 4],
      [1 / 4, 1 / 4],
      [2 / 4, 1 / 4],
      [3 / 4, 3 / 7 / 4],
    ];
    expect(model).toHaveLength(4);
    model.forEach((s, i) => {
      expect(s.left).toBeCloseTo(expected[i][0], 10);
      expect(s.width).toBeCloseTo(expected[i][1], 10);
    });
  });

  test("a gap is hatched and blank, never $0; no hours draws nothing", () => {
    const gap = makePricer(parseRatesFiles([GAP]));
    const model = stripModel(gap, { ...geometry, priceSpan: priceSpanOf(gap) });
    const hole = model.find((s) => s.kind === "gap")!;
    expect([hole.from, hole.to, hole.rate, hole.usd]).toEqual([
      "2026-11-02",
      "2026-11-08",
      null,
      0,
    ]);
    expect(hole.labels).toEqual(["no rates"]);
    expect(hole.title).toBe("No rates · Nov 2–8");
    expect(hole.lines).toEqual([
      "Not in the rates file: only the days it lists are priced.",
      "7.7K h unpriced, left out of $",
    ]);
    expect(
      stripModel(gap, {
        ...geometry,
        priceSpan: () => ({ usd: 0, hours: 0, unpriced: 0 }),
      })
    ).toEqual([]);
  });

  test("labels: the first candidate that fits, else none", () => {
    const c = ["Nov 9–15 · $0.11/h", "$0.11/h", "Nov 9"];
    expect(fitLabel(c, 200)).toBe(c[0]);
    expect(fitLabel(c, 60)).toBe("$0.11/h");
    expect(fitLabel(c, 42)).toBe("Nov 9");
    expect(fitLabel(c, 20)).toBeNull();
  });

  test("renders a hidden list of segments for screen readers; legacy files draw nothing", () => {
    const markup = renderToStaticMarkup(
      <RateStrip pricer={weekly} onHoverSpan={noop} {...geometry} />
    );
    const text = words(markup);
    expect(text).toContain(
      `Nov 9–15, Nov 9–15 rates, provisional, ${rateLabel(rateIn(3)).replace(
        "/h",
        " per hour"
      )}`
    );
    expect(text).toContain("Nov 16–18, no rates");
    expect(text).not.toMatch(/≈|priced with/);
    expect(markup).toContain('aria-hidden="true"');
    const legacy = makePricer(
      parseRatesFiles([{ name: "r.json", text: `{"${LABEL}": 1}` }])
    );
    expect(
      renderToStaticMarkup(
        <RateStrip pricer={legacy} onHoverSpan={noop} {...geometry} />
      )
    ).toBe("");
  });
});

describe("the rates control", () => {
  const props = {
    rates: null,
    error: null,
    dragging: false,
    exampleLabels: [LABEL],
    onFiles: noop,
    onClear: noop,
    onDismissError: noop,
  };
  const weekly = parseRatesFiles([WEEKLY, META]);

  test("asks for files, names a loaded set, and says what went wrong inline", () => {
    const empty = renderToStaticMarkup(<RatesControl {...props} />);
    expect(words(empty)).toBe("Download rates Add rates… Format");
    expect(empty).toMatch(/<input[^>]*multiple/);
    expect(empty).toMatch(/accept="application\/json,.json"/);
    // The download is a plain link out; HUD never fetches the file.
    const link = empty.match(/<a [^>]*>/)?.[0] ?? "";
    expect(link).toContain(`href="${RATES_FILE_URL}"`);
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener noreferrer"');
    const loaded = renderToStaticMarkup(
      <RatesControl {...props} rates={weekly} />
    );
    expect(words(loaded)).toBe(
      "Download rates rates_FAKE_weekly.json · 4 weekly periods Format"
    );
    expect(loaded).toContain('aria-label="Clear the rates"');
    expect(
      words(renderToStaticMarkup(<RatesControl {...props} dragging />))
    ).toBe("Download rates Drop rates files to load Format");
    expect(
      words(renderToStaticMarkup(<RatesControl {...props} error="Bad." />))
    ).toContain("Couldn't read the rates files. Bad. Dismiss");
    expect(
      words(
        renderToStaticMarkup(
          <RatesControl {...props} rates={weekly} error="Bad." />
        )
      )
    ).toContain("Kept rates_FAKE_weekly.json. Bad. Dismiss");
  });

  test("one line of one height: the download and the rates joined in a pill, Format a text button beside it", () => {
    // An element's own emotion rule.
    const rule = (html: string, tag: RegExp) => {
      const cls =
        html
          .match(tag)?.[0]
          .match(/css-[\w-]+/g)
          ?.pop() ?? "";
      return html.match(new RegExp(`\\.${cls}\\{([^}]*)\\}`))?.[1] ?? "";
    };
    for (const state of [{}, { rates: weekly }, { dragging: true }] as Partial<
      typeof props
    >[]) {
      const html = renderToStaticMarkup(<RatesControl {...props} {...state} />);
      // The pill holds both, up to the Format button.
      const pillWords = words(
        html
          .split('role="group" aria-label="Rates file"')[1]
          .split('aria-label="Rates file format"')[0]
          .replace(/^[^>]*>/, "")
          .replace(/<button [^>]*$/, "")
      );
      expect(pillWords).toBe(
        state.dragging
          ? "Download rates Drop rates files to load"
          : state.rates
          ? "Download rates rates_FAKE_weekly.json · 4 weekly periods"
          : "Download rates Add rates…"
      );
      const pill = rule(html, /<div [^>]*role="group"[^>]*>/);
      expect(pill).toContain("height:26px;");
      expect(pill).toContain("border-radius:999px;");
      const format = rule(
        html,
        /<button [^>]*aria-label="Rates file format"[^>]*>/
      );
      expect(format).toContain("height:26px;");
      expect(format).not.toContain("underline");
      // No gap in the column: the empty error line adds no height.
      const column = rule(html, /<div [^>]*>/);
      expect(column).toContain("flex-direction:column;");
      expect(column).not.toMatch(/gap/);
    }
  });

  test("nothing opens by itself: no format, tour or tip in the first render", () => {
    const text = words(renderToStaticMarkup(<RatesControl {...props} />));
    expect(text).not.toMatch(
      /rate sets by period|Download the internal|stay in this tab/
    );
  });

  test("the format's examples are a pair of files the page reads", () => {
    const { rates, meta } = formatExamples([LABEL, "linux.foo"]);
    const set = parseRatesFiles([
      { name: "rates.json", text: rates },
      { name: "rates.meta.json", text: meta },
    ]);
    expect(set.periods.map((p) => [p.validFrom, p.status])).toEqual([
      ["2026-11-02", "final"],
      ["2026-11-09", "provisional"],
    ]);
    expect(Object.keys(set.periods[0].rates)).toEqual([LABEL, "linux.foo"]);
    // The first period shows the optional totals; the second has none.
    expect(set.periods.map(periodTotals)).toEqual([
      { aws_total: 1000000, runner_nodes: 600000 },
      null,
    ]);
    const text = words(
      renderToStaticMarkup(<RatesFormatPeriods exampleLabels={[LABEL]} />)
    );
    expect(text).toContain("rates.json: rate sets by period");
    expect(text).toContain(
      "rates.meta.json (optional): status and source days"
    );
    expect(text).toContain("still loads as one set for every day");
    // Only listed days are priced; recent days need a period of their own.
    expect(text).toContain(
      "Only the days the periods list are priced: a day in none (a hole, or before the first or after the last period) stays unpriced and blank."
    );
    expect(text).toContain(
      "Recent days: to price them, the file must list a period for them"
    );
    expect(text).not.toMatch(/≈|Current period/);
    expect(text).toContain("Totals (optional): $ per period");
  });
});
