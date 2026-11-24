// Rates that change over time: the periods file and its meta
// as the page reads them, fails closed, and prices each day by its own
// period. Today is Thu 2026-11-19 (the trend answer's end), so yesterday is
// Wed Nov 18. Every rate here is FAKE.

import { addDays, type Day } from "lib/api/tests/cost/contracts";
import {
  cadenceOf,
  currentPeriod,
  daySpanLabel,
  dayTotals,
  makePricer,
  MAX_PERIODS,
  parseRatesFiles,
  periodTotals,
  pricedDays,
  pricingNotes,
  RATE_GRACE_SLOTS,
  ratesChip,
  readRatesFiles,
} from "lib/tests/cost/ratePeriods";
import { parseRates, rateOf } from "lib/tests/cost/rates";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TODAY = "2026-11-19";
const text = (name: string) => readFileSync(join(__dirname, name), "utf8");
const WEEKLY = {
  name: "rates_FAKE_weekly.json",
  text: text("rates_FAKE_weekly.json"),
};
const META = {
  name: "rates_FAKE_weekly.meta.json",
  text: text("rates_FAKE_weekly.meta.json"),
};
const GAP = {
  name: "rates_FAKE_weekly_gap.json",
  text: text("rates_FAKE_weekly_gap.json"),
};
const weeklyJson = JSON.parse(WEEKLY.text);
const LABEL = "mt-l-x86iavx512-16-128";
// Missing from the Oct 26 – Nov 1 period.
const PATCHY = "mt-l-arm64g4-16-62";
const rateIn = (period: number, label = LABEL): number =>
  weeklyJson.periods[period].rates[label];

function error(f: () => unknown): string {
  try {
    f();
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}

function days(from: Day, to: Day): Day[] {
  const out: Day[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// The weekly file cut to its first n periods.
function firstPeriods(n: number) {
  return parseRatesFiles([
    {
      name: "cut.json",
      text: JSON.stringify({
        ...weeklyJson,
        periods: weeklyJson.periods.slice(0, n),
      }),
    },
  ]);
}

describe("reading rates files", () => {
  test("legacy files load as one set for every day, rates exactly as parseRates reads them", () => {
    const bare = '{"linux.2xlarge": 0.5, "linux.4xlarge": 0}';
    const wrapped = JSON.stringify({
      valid_from: "2026-10-01",
      basis: "made up",
      window: { start: "2026-09-02", end: "2026-10-01" },
      rates: { "linux.2xlarge": 0.5 },
    });
    for (const t of [bare, wrapped]) {
      const set = parseRatesFiles([{ name: "r.json", text: t }]);
      expect(set.legacy).toBe(true);
      expect(set.periods).toHaveLength(1);
      expect(set.periods[0].rates).toEqual(parseRates(t, "r.json").rates);
      expect(set.periods[0]).toMatchObject({
        validFrom: null,
        validThrough: null,
        status: null,
      });
      expect(ratesChip(set)).toBe("r.json · one set for every day");
      const pricer = makePricer(set, TODAY);
      for (const day of ["2020-01-01", "2026-11-18", "2030-06-30"]) {
        expect(pricer.dayKind(day)).toBe("legacy");
        expect(pricer.rate("linux.2xlarge", day)).toBe(0.5);
      }
      expect(currentPeriod(set, TODAY)).toBeNull();
    }
    const set = parseRatesFiles([{ name: "r.json", text: wrapped }]);
    expect(set.basis).toBe("made up");
    expect(set.periods[0].window).toEqual({
      start: "2026-09-02",
      end: "2026-10-01",
    });
    // Today's errors, unchanged.
    expect(error(() => parseRatesFiles([{ name: "f.json", text: "{}" }]))).toBe(
      "f.json has no rates."
    );
    expect(
      error(() => parseRatesFiles([{ name: "f.json", text: '{"a": "1"}' }]))
    ).toMatch(/^Rates must be numbers from 0 to 100,000/);
  });

  test("a periods file with one period over every day prices as the legacy file does", () => {
    const rates = { "linux.2xlarge": 0.5, "linux.4xlarge": 1 };
    const legacy = makePricer(
      parseRatesFiles([{ name: "a.json", text: JSON.stringify(rates) }]),
      TODAY
    );
    const periods = makePricer(
      parseRatesFiles([
        {
          name: "b.json",
          text: JSON.stringify({
            periods: [
              { valid_from: "2026-01-01", valid_through: "2026-12-31", rates },
            ],
          }),
        },
      ]),
      TODAY
    );
    for (const day of days("2026-10-29", "2026-11-18")) {
      for (const label of ["linux.2xlarge", "self-hosted,linux.4xlarge", "x"]) {
        expect(periods.rate(label, day)).toBe(legacy.rate(label, day));
      }
    }
  });

  test("weekly rates and meta load in either order: sorted periods, statuses, windows, the chip", () => {
    for (const files of [
      [WEEKLY, META],
      [META, WEEKLY],
    ]) {
      const set = parseRatesFiles(files);
      expect(set.legacy).toBe(false);
      expect(set.file).toBe("rates_FAKE_weekly.json");
      expect(set.metaFile).toBe("rates_FAKE_weekly.meta.json");
      expect(set.generatedAt).toBe("2026-11-19T06:00:00Z");
      expect(set.periods.map((p) => [p.validFrom, p.status])).toEqual([
        ["2026-10-19", "final"],
        ["2026-10-26", "final"],
        ["2026-11-02", "final"],
        ["2026-11-09", "provisional"],
      ]);
      expect(set.periods[3].window).toEqual({
        start: "2026-11-09",
        end: "2026-11-13",
      });
      expect(cadenceOf(set)).toBe("weekly");
      expect(ratesChip(set)).toBe(
        "rates_FAKE_weekly.json · 4 weekly periods · Oct 19 – Nov 15 · generated Nov 19"
      );
    }
    expect(ratesChip(parseRatesFiles([WEEKLY, META]), true)).toBe(
      "rates_FAKE_weekly.json · 4 weekly periods"
    );
    // Without the meta: no status, no generated part.
    const alone = parseRatesFiles([WEEKLY]);
    expect(alone.periods.every((p) => p.status === null)).toBe(true);
    expect(ratesChip(alone)).toBe(
      "rates_FAKE_weekly.json · 4 weekly periods · Oct 19 – Nov 15"
    );
    // Any order in the file.
    const shuffled = parseRatesFiles([
      {
        name: "s.json",
        text: JSON.stringify({
          periods: [...weeklyJson.periods].reverse(),
        }),
      },
    ]);
    expect(shuffled.periods.map((p) => p.validFrom)).toEqual(
      alone.periods.map((p) => p.validFrom)
    );
  });

  test("the gap file with the weekly meta is an error, and so is a meta alone", () => {
    expect(error(() => parseRatesFiles([GAP, META]))).toBe(
      "rates_FAKE_weekly.meta.json has period 2026-11-02, which rates_FAKE_weekly_gap.json lacks. Were they generated together?"
    );
    expect(error(() => parseRatesFiles([META]))).toBe(
      "rates_FAKE_weekly.meta.json is a rates.meta.json: add its rates.json too (drop both together)."
    );
    // A meta alone attaches to the set held, and replaces a meta held.
    const held = parseRatesFiles([WEEKLY]);
    const attached = parseRatesFiles([META], held);
    expect(attached.periods[3].status).toBe("provisional");
    const otherMeta = JSON.parse(META.text);
    otherMeta.periods[3].status = "final";
    const replaced = parseRatesFiles(
      [{ name: "m2.json", text: JSON.stringify(otherMeta) }],
      attached
    );
    expect(replaced.metaFile).toBe("m2.json");
    expect(replaced.periods.every((p) => p.status === "final")).toBe(true);
    // A meta that doesn't fit the set held fails and changes nothing.
    const gapHeld = parseRatesFiles([GAP]);
    expect(error(() => parseRatesFiles([META], gapHeld))).toMatch(
      /has period 2026-11-02/
    );
    expect(gapHeld.metaFile).toBeNull();
    // A meta with a legacy file.
    expect(
      error(() => parseRatesFiles([{ name: "r.json", text: '{"a": 1}' }, META]))
    ).toBe(
      "rates_FAKE_weekly.meta.json goes with a rates file of periods; r.json holds one set for every day."
    );
  });

  test("bad files fail with one sentence", () => {
    const one = (json: unknown, name = "f.json") =>
      error(() => parseRatesFiles([{ name, text: JSON.stringify(json) }]));
    const period = (
      from: string,
      through: string,
      rates: unknown = { a: 1 }
    ) => ({
      valid_from: from,
      valid_through: through,
      rates,
    });
    expect(
      one({ periods: [period("2026-11-02", "2026-11-08")], rates: {} })
    ).toBe("Use either periods or rates, not both.");
    expect(
      one({
        periods: [
          period("2026-11-02", "2026-11-08"),
          period("2026-11-05", "2026-11-11"),
        ],
      })
    ).toBe(
      "Periods 2026-11-02..11-08 and 2026-11-05..11-11 overlap; each day needs one rate set."
    );
    // A duplicate start is an overlap.
    expect(
      one({
        periods: [
          period("2026-11-02", "2026-11-08"),
          period("2026-11-02", "2026-11-02"),
        ],
      })
    ).toMatch(/overlap/);
    expect(one({ periods: [period("2026-11-08", "2026-11-02")] })).toBe(
      "Period 1 (2026-11-08..11-02): valid_from comes after valid_through."
    );
    expect(one({ periods: [period("2026-11-02", "2026-11-08", {})] })).toBe(
      "Period 1 (2026-11-02..11-08) has no rates."
    );
    expect(
      one({
        periods: [
          period("2026-10-19", "2026-10-25"),
          period("2026-10-26", "2026-11-01"),
          period("2026-11-02", "2026-11-08", { x: "abc", y: 1 }),
        ],
      })
    ).toBe(
      'Period 3 (2026-11-02..11-08): rates must be numbers from 0 to 100,000: x is "abc".'
    );
    expect(one({ periods: [period("2026-02-30", "2026-03-01")] })).toMatch(
      /^Period 1: valid_from must be a UTC day/
    );
    expect(one({ periods: [] })).toBe("f.json has no periods.");
    expect(one({ periods: {} })).toMatch(/periods must be a list/);
    const many = Array.from({ length: MAX_PERIODS + 1 }, (_, i) => {
      const d = addDays("2024-01-01", i);
      return period(d, d);
    });
    expect(one({ periods: many })).toBe(
      "f.json has 801 periods; the limit is 800."
    );
    expect(one({ periods: many.slice(0, MAX_PERIODS) })).toBe("");
    // The size cap, before parsing.
    const huge = `{"periods": [], "pad": "${"x".repeat(4_100_000)}"}`;
    expect(
      error(() => parseRatesFiles([{ name: "big.json", text: huge }]))
    ).toBe("big.json is 4,100 KB; the limit is 4 MB.");
    expect(
      error(() => parseRatesFiles([{ name: "j.json", text: "{" }]))
    ).toMatch(/^j\.json is not valid JSON/);
    // How many files, and which.
    const files =
      "Drop one rates.json and, if you have it, its rates.meta.json.";
    expect(error(() => parseRatesFiles([]))).toBe(files);
    expect(error(() => parseRatesFiles([WEEKLY, GAP]))).toBe(files);
    expect(error(() => parseRatesFiles([META, META]))).toBe(files);
    expect(error(() => parseRatesFiles([WEEKLY, META, GAP]))).toBe(files);
  });

  test("the meta is strict", () => {
    const meta = (patch: (_m: any) => void) => {
      const m = JSON.parse(META.text);
      patch(m);
      return error(() =>
        parseRatesFiles([WEEKLY, { name: "m.json", text: JSON.stringify(m) }])
      );
    };
    expect(meta((m) => (m.periods[1].status = "done"))).toBe(
      "m.json period 2: status must be final or provisional."
    );
    expect(meta((m) => delete m.periods[0].status)).toBe(
      "m.json period 1: status must be final or provisional."
    );
    expect(
      meta(
        (m) =>
          (m.periods[0].window = { start: "2026-10-25", end: "2026-10-19" })
      )
    ).toMatch(/^m\.json period 1: window must be/);
    expect(meta((m) => (m.periods[0].valid_from = "Oct 19"))).toMatch(
      /^m\.json period 1: valid_from must be a UTC day/
    );
    expect(meta((m) => (m.generated_at = "yesterday"))).toMatch(
      /^m\.json: generated_at must be an ISO 8601 time/
    );
    expect(meta((m) => m.periods.push(m.periods[0]))).toBe(
      "m.json lists period 2026-10-19 twice."
    );
    expect(meta((m) => delete m.periods[0].window)).toBe("");
    // generated_at in both files must agree.
    const stamped = JSON.stringify({
      ...weeklyJson,
      generated_at: "2026-11-18T06:00:00Z",
    });
    expect(
      error(() => parseRatesFiles([{ name: "r.json", text: stamped }, META]))
    ).toBe(
      "r.json was generated at 2026-11-18T06:00:00Z and rates_FAKE_weekly.meta.json at 2026-11-19T06:00:00Z. Were they generated together?"
    );
    const same = JSON.stringify({
      ...weeklyJson,
      generated_at: "2026-11-19T06:00:00.000Z",
    });
    expect(
      error(() => parseRatesFiles([{ name: "r.json", text: same }, META]))
    ).toBe("");
  });

  test("readRatesFiles checks sizes before reading and labels after", async () => {
    const file = (f: { name: string; text: string }) =>
      new File([f.text], f.name, { type: "application/json" });
    const set = await readRatesFiles([file(WEEKLY), file(META)], [LABEL]);
    expect(set.metaFile).toBe(META.name);
    await expect(
      readRatesFiles([file(WEEKLY)], ["linux.foo", "self-hosted,linux.bar"])
    ).rejects.toThrow(
      "None of rates_FAKE_weekly.json's labels ran here; keys are runner labels like linux.foo."
    );
    // No labels known yet: no check.
    await expect(readRatesFiles([file(WEEKLY)], [])).resolves.toBeTruthy();
    const big = {
      name: "big.json",
      size: 5_210_000,
      text: () => {
        throw new Error("read");
      },
    } as unknown as File;
    await expect(readRatesFiles([big], [])).rejects.toThrow(
      "big.json is 5,210 KB; the limit is 4 MB."
    );
    await expect(readRatesFiles([], [])).rejects.toThrow(/^Drop one rates/);
  });
});

describe("pricing each day by its period", () => {
  const weekly = parseRatesFiles([WEEKLY, META]);
  const pricer = makePricer(weekly, TODAY);

  test("each day takes its own period's rate; boundaries, gaps and missing labels stay unpriced", () => {
    expect(RATE_GRACE_SLOTS).toBe(0);
    // Nov 1 | Nov 2 is a boundary where the rate changes.
    expect(rateIn(2)).not.toBe(rateIn(1));
    expect(pricer.rate(LABEL, "2026-11-01")).toBe(rateIn(1));
    expect(pricer.rate(LABEL, "2026-11-02")).toBe(rateIn(2));
    expect(pricer.rate(LABEL, "2026-11-08")).toBe(rateIn(2));
    expect(pricer.rate(LABEL, "2026-11-09")).toBe(rateIn(3));
    expect(pricer.rate(`self-hosted,${LABEL}`, "2026-11-09")).toBe(rateIn(3));
    // Multi-label jobs have no single rate.
    expect(pricer.rate(`${LABEL},linux.foo`, "2026-11-09")).toBeNull();
    // Before the first period: a gap.
    expect(pricer.dayKind("2026-10-18")).toBe("gap");
    expect(pricer.rate(LABEL, "2026-10-18")).toBeNull();
    // A label one period lacks.
    expect(pricer.rate(PATCHY, "2026-10-28")).toBeNull();
    expect(pricer.rate(PATCHY, "2026-11-02")).toBe(rateIn(2, PATCHY));
    expect(pricer.dayKind("2026-11-10")).toBe("provisional");
    expect(pricer.dayKind("2026-11-01")).toBe("final");
    // The legacy rates.ts still prices a single set its own way.
    expect(rateOf(parseRates('{"a": 0}', "z.json"), "a")).toBe(0);
  });

  test("every boundary: each side takes its own period's rate, and the two differ", () => {
    // The FAKE file changes every label's rate at every boundary, so a day
    // priced with its neighbour's period (final, provisional or borrowed)
    // fails here.
    const periods = weeklyJson.periods as {
      valid_from: string;
      valid_through: string;
      rates: Record<string, number>;
    }[];
    let checked = 0;
    for (let i = 1; i < periods.length; i++) {
      const [before, after] = [periods[i - 1], periods[i]];
      expect(addDays(before.valid_through, 1)).toBe(after.valid_from);
      expect(pricer.dayKind(after.valid_from)).toBe(
        i === 3 ? "provisional" : "final"
      );
      for (const label of Object.keys(after.rates)) {
        if (!(label in before.rates)) continue;
        expect(before.rates[label]).not.toBe(after.rates[label]);
        expect(pricer.rate(label, before.valid_through)).toBe(
          before.rates[label]
        );
        expect(pricer.rate(label, after.valid_from)).toBe(after.rates[label]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
    // The borrowed days after the file take its last period's rate, not
    // the one before it.
    for (const label of Object.keys(periods[3].rates)) {
      expect(pricer.dayKind("2026-11-16")).toBe("borrowed");
      expect(pricer.rate(label, "2026-11-16")).toBe(periods[3].rates[label]);
      if (label in periods[2].rates) {
        expect(pricer.rate(label, "2026-11-16")).not.toBe(
          periods[2].rates[label]
        );
      }
    }
  });

  test("current period, strict: only the slot holding yesterday borrows the last period", () => {
    // Ends Sun Nov 15: Nov 16–18 borrowed from Nov 9–15 (provisional).
    expect(pricer.segments({ from: "2026-11-09", to: "2026-11-18" })).toEqual([
      { from: "2026-11-09", to: "2026-11-15", kind: "provisional", period: 3 },
      { from: "2026-11-16", to: "2026-11-18", kind: "borrowed", period: 3 },
    ]);
    expect(pricer.rate(LABEL, "2026-11-17")).toBe(rateIn(3));
    // Today and later have no data and no pricing.
    expect(pricer.dayKind("2026-11-19")).toBe("gap");

    // Ends Nov 8: Nov 16–18 borrowed from Nov 2–8, Nov 9–15 a gap.
    const toNov8 = makePricer(firstPeriods(3), TODAY);
    expect(toNov8.segments({ from: "2026-11-02", to: "2026-11-18" })).toEqual([
      { from: "2026-11-02", to: "2026-11-08", kind: "final", period: 2 },
      { from: "2026-11-09", to: "2026-11-15", kind: "gap", period: null },
      { from: "2026-11-16", to: "2026-11-18", kind: "borrowed", period: 2 },
    ]);
    expect(toNov8.rate(LABEL, "2026-11-12")).toBeNull();
    expect(toNov8.rate(LABEL, "2026-11-16")).toBe(rateIn(2));

    // Ends Nov 1: Nov 16–18 borrowed, Nov 2–15 a gap.
    const toNov1 = makePricer(firstPeriods(2), TODAY);
    expect(toNov1.segments({ from: "2026-10-26", to: "2026-11-18" })).toEqual([
      { from: "2026-10-26", to: "2026-11-01", kind: "final", period: 1 },
      { from: "2026-11-02", to: "2026-11-15", kind: "gap", period: null },
      { from: "2026-11-16", to: "2026-11-18", kind: "borrowed", period: 1 },
    ]);
    // Borrowing never fills a label the last period lacks.
    expect(toNov1.rate(PATCHY, "2026-11-17")).toBeNull();

    // A file reaching yesterday has no current period.
    const reaching = parseRatesFiles([
      {
        name: "r.json",
        text: JSON.stringify({
          periods: [
            {
              valid_from: "2026-11-16",
              valid_through: "2026-11-22",
              rates: { a: 1 },
            },
          ],
        }),
      },
    ]);
    expect(currentPeriod(reaching, TODAY)).toBeNull();
    // A monthly file ending Oct 31: Nov 1–18 borrowed (the month slot).
    const monthly = parseRatesFiles([
      {
        name: "m.json",
        text: JSON.stringify({
          periods: [
            {
              valid_from: "2026-09-01",
              valid_through: "2026-09-30",
              rates: { a: 1 },
            },
            {
              valid_from: "2026-10-01",
              valid_through: "2026-10-31",
              rates: { a: 2 },
            },
          ],
        }),
      },
    ]);
    expect(cadenceOf(monthly)).toBe("monthly");
    expect(currentPeriod(monthly, TODAY)).toEqual({
      from: "2026-11-01",
      to: "2026-11-18",
      period: 1,
    });
  });

  test("a split last week: slots keep the last period's length, so only the slot holding yesterday borrows", () => {
    // Nov 9–15 split by a hole on Nov 11: the last period is Nov 12–15, so the
    // slots after it are 4 days long (Nov 16–19, Nov 20–23).
    const w = weeklyJson.periods;
    const split = parseRatesFiles([
      {
        name: "split.json",
        text: JSON.stringify({
          ...weeklyJson,
          periods: [
            ...w.slice(0, 3),
            { ...w[3], valid_through: "2026-11-10" },
            { ...w[3], valid_from: "2026-11-12" },
          ],
        }),
      },
    ]);
    expect(currentPeriod(split, "2026-11-23")).toEqual({
      from: "2026-11-20",
      to: "2026-11-22",
      period: 4,
    });
    expect(
      makePricer(split, "2026-11-23")
        .segments({ from: "2026-11-09", to: "2026-11-22" })
        .map((s) => [s.from, s.to, s.kind])
    ).toEqual([
      ["2026-11-09", "2026-11-10", "final"],
      ["2026-11-11", "2026-11-11", "gap"],
      ["2026-11-12", "2026-11-15", "final"],
      ["2026-11-16", "2026-11-19", "gap"],
      ["2026-11-20", "2026-11-22", "borrowed"],
    ]);
  });

  test("piece: exact inside a week, ≈ across a mid-week boundary, weighting only the days passed", () => {
    const inWeek = pricer.piece(LABEL, days("2026-11-03", "2026-11-07"));
    expect(inWeek).toEqual({
      rate: rateIn(2),
      priced: 1,
      exact: true,
      borrowed: false,
    });
    const across = pricer.piece(LABEL, days("2026-10-30", "2026-11-05"));
    expect(across.exact).toBe(false);
    expect(across.priced).toBe(1);
    expect(across.rate).toBeCloseTo((3 * rateIn(1) + 4 * rateIn(2)) / 7, 10);
    // Only the days given count: Oct 26 and two days of the next week.
    const sparse = pricer.piece(LABEL, [
      "2026-10-26",
      "2026-11-02",
      "2026-11-03",
    ]);
    expect(sparse.rate).toBeCloseTo((rateIn(1) + 2 * rateIn(2)) / 3, 10);
    // A gap day lowers the priced share.
    const gap = makePricer(parseRatesFiles([GAP]), TODAY);
    const half = gap.piece(LABEL, [
      "2026-11-07",
      "2026-11-08",
      "2026-11-09",
      "2026-11-10",
    ]);
    expect(half).toEqual({
      rate: rateIn(3),
      priced: 0.5,
      exact: false,
      borrowed: false,
    });
    // Wholly in a gap: exactly unpriced.
    expect(gap.piece(LABEL, days("2026-11-02", "2026-11-08"))).toEqual({
      rate: null,
      priced: 0,
      exact: true,
      borrowed: false,
    });
    // Borrowed days mark the piece.
    expect(pricer.piece(LABEL, days("2026-11-16", "2026-11-18"))).toEqual({
      rate: rateIn(3),
      priced: 1,
      exact: true,
      borrowed: true,
    });
    expect(pricer.piece(LABEL, [])).toEqual({
      rate: null,
      priced: 0,
      exact: true,
      borrowed: false,
    });
  });

  test("piece: a rate period starting mid-week; day pieces sum to each day's hours at its rate, a week piece doesn't", () => {
    // Nov 9–15 cut into Nov 9–10 and Nov 12–15 (rates doubled), Nov 11 a
    // hole, as a file whose periods start on any day.
    const last = weeklyJson.periods[3];
    const doubled = Object.fromEntries(
      Object.entries(last.rates as Record<string, number>).map(([k, r]) => [
        k,
        r * 2,
      ])
    );
    const midWeek = makePricer(
      parseRatesFiles([
        {
          name: "rates_FAKE_hole.json",
          text: JSON.stringify({
            ...weeklyJson,
            periods: [
              ...weeklyJson.periods.slice(0, 3),
              { ...last, valid_through: "2026-11-10" },
              { ...last, valid_from: "2026-11-12", rates: doubled },
            ],
          }),
        },
      ]),
      TODAY
    );
    const week = days("2026-11-09", "2026-11-15");
    const hours = [100, 100, 100, 10, 10, 10, 10];
    const perDay = week.reduce(
      (t, d, i) => t + hours[i] * (midWeek.rate(LABEL, d) ?? 0),
      0
    );
    expect(perDay).toBeCloseTo(200 * rateIn(3) + 40 * 2 * rateIn(3), 10);
    // Day pieces: each exact, and h·priced·rate adds up to the per-day $.
    let byDay = 0;
    week.forEach((d, i) => {
      const p = midWeek.piece(LABEL, [d]);
      expect(p.exact).toBe(true);
      if (p.rate !== null) byDay += hours[i] * p.priced * p.rate;
    });
    expect(byDay).toBeCloseTo(perDay, 10);
    expect(midWeek.piece(LABEL, ["2026-11-11"])).toEqual({
      rate: null,
      priced: 0,
      exact: true,
      borrowed: false,
    });
    // One week piece: the mean of its priced days' rates, inexact, off.
    const p = midWeek.piece(LABEL, week);
    expect(p.exact).toBe(false);
    expect(p.priced).toBeCloseTo(6 / 7, 10);
    expect(p.rate).toBeCloseTo((2 * rateIn(3) + 4 * 2 * rateIn(3)) / 6, 10);
    const total = hours.reduce((t, h) => t + h, 0);
    expect(
      Math.abs(total * p.priced * (p.rate as number) - perDay)
    ).toBeGreaterThan(perDay * 0.2);
  });

  test("$ per day divides by priced days; $ per commit by the pushes of priced days only", () => {
    // B = Nov 2–15 with the gap file: Nov 2–8 has no rates, Nov 9–15 does.
    const gap = makePricer(parseRatesFiles([GAP]), TODAY);
    const b = days("2026-11-02", "2026-11-15");
    const hours = (i: number) => 1000 + 10 * i; // LABEL's hours that day
    const main = (i: number) => 100 + i; // of them, push:main
    const pushes = b.map((_, i) => 40 + i);
    let usd = 0;
    let mainUsd = 0;
    let unpriced = 0;
    b.forEach((day, i) => {
      const r = gap.rate(LABEL, day);
      if (r === null) unpriced += hours(i);
      else {
        usd += hours(i) * r;
        mainUsd += main(i) * r;
      }
    });
    const divisors = pricedDays(gap, { days: b, pushes });
    expect(divisors).toEqual({
      days: 7,
      of: 14,
      pushes: pushes.slice(7).reduce((a, n) => a + n, 0),
      note: "7 of 14 days priced",
    });
    // Per day: over the 7 priced days, not 14.
    const perDay = usd / divisors.days;
    const priced = b.slice(7).reduce((a, _, j) => a + hours(j + 7), 0);
    expect(perDay).toBeCloseTo((priced * rateIn(3)) / 7, 6);
    expect(unpriced).toBe(b.slice(0, 7).reduce((a, _, i) => a + hours(i), 0));
    // Per commit: $ of main hours on priced days ÷ those days' pushes.
    const perCommit = mainUsd / divisors.pushes;
    const mainPriced = b.slice(7).reduce((a, _, j) => a + main(j + 7), 0);
    expect(perCommit).toBeCloseTo(
      (mainPriced * rateIn(3)) / pushes.slice(7).reduce((a, n) => a + n, 0),
      8
    );
    // Every day priced: no note.
    expect(pricedDays(pricer, { days: b }).note).toBeNull();
  });

  test("the coverage line says what is notable, and nothing otherwise", () => {
    const range = { from: "2026-10-29", to: "2026-11-18" };
    expect(pricer.coverageLine(range, 21_000)).toBe(
      "Rates Oct 19 – Nov 15 (Nov 9–15 provisional) · ≈ Nov 16–18 priced with Nov 9–15 rates · 21K h unpriced"
    );
    const gap = makePricer(parseRatesFiles([GAP]), TODAY);
    expect(gap.coverageLine(range, 0)).toBe(
      "Rates Oct 19 – Nov 15 · ≈ Nov 16–18 priced with Nov 9–15 rates · Nov 2–8 no rates"
    );
    // Inside one final period, every hour priced: nothing to say.
    expect(
      pricer.coverageLine({ from: "2026-11-02", to: "2026-11-08" }, 0)
    ).toBeNull();
    const legacy = makePricer(
      parseRatesFiles([{ name: "r.json", text: '{"a": 1}' }]),
      TODAY
    );
    expect(legacy.coverageLine(range, 0)).toBeNull();
    expect(legacy.coverageLine(range, 1500)).toBe(
      "1.5K h on labels without a rate"
    );
  });

  test("day spans read as the page writes them", () => {
    expect(daySpanLabel("2026-11-09", "2026-11-09")).toBe("Nov 9");
    expect(daySpanLabel("2026-11-09", "2026-11-15")).toBe("Nov 9–15");
    expect(daySpanLabel("2026-10-19", "2026-11-15")).toBe("Oct 19 – Nov 15");
    expect(daySpanLabel("2025-12-29", "2026-01-04")).toBe(
      "Dec 29, 2025 – Jan 4, 2026"
    );
  });
});

describe("pricing notes", () => {
  test("borrowed days read ≈ and name the last period, provisional ones their window", () => {
    const pricer = makePricer(parseRatesFiles([WEEKLY, META]), TODAY);
    expect(pricingNotes(pricer, ["2026-11-17"])).toEqual({
      approx: true,
      lines: [
        "≈ priced with Nov 9–15 rates (provisional; no rates for these days yet)",
      ],
    });
    expect(pricingNotes(pricer, ["2026-11-10"])).toEqual({
      approx: false,
      lines: ["Provisional: rates from Nov 9–13"],
    });
    expect(pricingNotes(pricer, ["2026-11-03"])).toEqual({
      approx: false,
      lines: [],
    });
    // Without the meta nothing is provisional.
    const plain = makePricer(parseRatesFiles([WEEKLY]), TODAY);
    expect(pricingNotes(plain, ["2026-11-10", "2026-11-17"]).lines).toEqual([
      "≈ priced with Nov 9–15 rates (no rates for these days yet)",
    ]);
  });
});

describe("per-period totals (the banner's AWS bill)", () => {
  const period = (totals: unknown, rates: unknown = { a: 1 }) => ({
    valid_from: "2026-11-02",
    valid_through: "2026-11-08",
    rates,
    ...(totals === undefined ? {} : { totals }),
  });
  const one = (totals: unknown) =>
    error(() =>
      parseRatesFiles([
        { name: "f.json", text: JSON.stringify({ periods: [period(totals)] }) },
      ])
    );

  test("optional, read with the period, kept through a meta and prorated per day", () => {
    const weekly = parseRatesFiles([WEEKLY, META]);
    // The FAKE files carry round totals on every period.
    expect(weekly.periods.map(periodTotals)).toEqual(
      weekly.periods.map(() => ({ aws_total: 200000, runner_nodes: 100000 }))
    );
    // A meta dropped after the rates keeps them.
    const later = parseRatesFiles([META], parseRatesFiles([WEEKLY]));
    expect(periodTotals(later.periods[3])).toEqual({
      aws_total: 200000,
      runner_nodes: 100000,
    });
    const pricer = makePricer(weekly, TODAY);
    // A week's total over its 7 days; the current slot borrows the last week's.
    expect(dayTotals(pricer, "2026-11-10")).toEqual({
      aws_total: 200000 / 7,
      runner_nodes: 100000 / 7,
    });
    expect(dayTotals(pricer, "2026-11-17")).toEqual(
      dayTotals(pricer, "2026-11-10")
    );
    expect(dayTotals(pricer, "2026-10-18")).toBeNull();
    // A gap day has none.
    const gap = makePricer(parseRatesFiles([GAP]), TODAY);
    expect(dayTotals(gap, "2026-11-04")).toBeNull();
    // Without totals, or a legacy file: none, and the files load as before.
    const bare = parseRatesFiles([
      {
        name: "b.json",
        text: JSON.stringify({ periods: [period(undefined)] }),
      },
    ]);
    expect(periodTotals(bare.periods[0])).toBeNull();
    expect(dayTotals(makePricer(bare, TODAY), "2026-11-03")).toBeNull();
    const legacy = parseRatesFiles([{ name: "l.json", text: '{"a": 1}' }]);
    expect(dayTotals(makePricer(legacy, TODAY), "2026-11-03")).toBeNull();
    // runner_nodes is optional.
    expect(one({ aws_total: 70 })).toBe("");
    const only = parseRatesFiles([
      {
        name: "o.json",
        text: JSON.stringify({ periods: [period({ aws_total: 70 })] }),
      },
    ]);
    expect(dayTotals(makePricer(only, TODAY), "2026-11-03")).toEqual({
      aws_total: 10,
      runner_nodes: null,
    });
  });

  test("bad totals fail with one sentence", () => {
    const shape =
      "Period 1 (2026-11-02..11-08): totals must be {aws_total, runner_nodes?}, $ from 0 to 1e12";
    expect(one(5)).toBe(`${shape}.`);
    expect(one({})).toBe(`${shape}; aws_total is null.`);
    expect(one({ aws_total: -1 })).toBe(`${shape}; aws_total is -1.`);
    expect(one({ aws_total: "1" })).toBe(`${shape}; aws_total is "1".`);
    expect(one({ aws_total: 10, runner_nodes: 1e13 })).toBe(
      `${shape}; runner_nodes is 10000000000000.`
    );
    expect(one({ aws_total: 10, aws_totl: 1 })).toBe(`${shape}; got aws_totl.`);
    expect(one({ aws_total: 10, runner_nodes: 11 })).toBe(
      "Period 1 (2026-11-02..11-08): totals.runner_nodes is more than aws_total."
    );
  });
});
