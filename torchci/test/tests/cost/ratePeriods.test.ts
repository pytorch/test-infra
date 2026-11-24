// Rates that change over time: the periods file and its meta
// as the page reads them, fails closed, and prices each day by its own
// period, and only the days some period lists. The data runs through Wed
// 2026-11-18 and the weekly file ends Sun Nov 15, so Nov 16–18 have no
// rates. Every rate here is FAKE.

import { addDays, type Day } from "lib/api/tests/cost/contracts";
import {
  cadenceOf,
  daySpanLabel,
  dayTotals,
  makePricer,
  MAX_PERIODS,
  parseRatesFiles,
  periodTotals,
  pricedDays,
  pricingNotes,
  ratesChip,
  readRatesFiles,
} from "lib/tests/cost/ratePeriods";
import { parseRates, rateOf } from "lib/tests/cost/rates";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
      const pricer = makePricer(set);
      for (const day of ["2020-01-01", "2026-11-18", "2030-06-30"]) {
        expect(pricer.dayKind(day)).toBe("legacy");
        expect(pricer.rate("linux.2xlarge", day)).toBe(0.5);
      }
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
      parseRatesFiles([{ name: "a.json", text: JSON.stringify(rates) }])
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
      ])
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
  const pricer = makePricer(weekly);

  test("each day takes its own period's rate; boundaries, gaps and missing labels stay unpriced", () => {
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
    // priced with its neighbour's period (final or provisional) fails here.
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
    // The last boundary is the file's end: the day after it is a gap, with
    // no label priced, neither at the last period's rate nor any other.
    expect(pricer.dayKind("2026-11-16")).toBe("gap");
    for (const label of Object.keys(periods[3].rates)) {
      expect(pricer.rate(label, "2026-11-15")).toBe(periods[3].rates[label]);
      expect(pricer.rate(label, "2026-11-16")).toBeNull();
    }
  });

  test("only the days the file lists are priced: every day after its last period is a gap, however far back it ends", () => {
    // Ends Sun Nov 15: Nov 16–18 are a gap, not the last week's rates.
    expect(pricer.segments({ from: "2026-11-09", to: "2026-11-18" })).toEqual([
      { from: "2026-11-09", to: "2026-11-15", kind: "provisional", period: 3 },
      { from: "2026-11-16", to: "2026-11-18", kind: "gap", period: null },
    ]);
    expect(pricer.rate(LABEL, "2026-11-17")).toBeNull();
    expect(pricer.dayKind("2026-11-19")).toBe("gap");

    // Ends Nov 8: Nov 9–18 a gap.
    const toNov8 = makePricer(firstPeriods(3));
    expect(toNov8.segments({ from: "2026-11-02", to: "2026-11-18" })).toEqual([
      { from: "2026-11-02", to: "2026-11-08", kind: "final", period: 2 },
      { from: "2026-11-09", to: "2026-11-18", kind: "gap", period: null },
    ]);
    expect(toNov8.rate(LABEL, "2026-11-12")).toBeNull();
    expect(toNov8.rate(LABEL, "2026-11-16")).toBeNull();

    // Ends Nov 1: Nov 2–18 a gap.
    const toNov1 = makePricer(firstPeriods(2));
    expect(toNov1.segments({ from: "2026-10-26", to: "2026-11-18" })).toEqual([
      { from: "2026-10-26", to: "2026-11-01", kind: "final", period: 1 },
      { from: "2026-11-02", to: "2026-11-18", kind: "gap", period: null },
    ]);

    // A file listing the recent days prices them, as any period.
    const reaching = makePricer(
      parseRatesFiles([
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
      ])
    );
    expect(reaching.segments({ from: "2026-11-15", to: "2026-11-18" })).toEqual(
      [
        { from: "2026-11-15", to: "2026-11-15", kind: "gap", period: null },
        { from: "2026-11-16", to: "2026-11-18", kind: "final", period: 0 },
      ]
    );
    // A monthly file ending Oct 31: all of November is a gap.
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
    expect(
      makePricer(monthly).segments({ from: "2026-10-31", to: "2026-11-18" })
    ).toEqual([
      { from: "2026-10-31", to: "2026-10-31", kind: "final", period: 1 },
      { from: "2026-11-01", to: "2026-11-18", kind: "gap", period: null },
    ]);
  });

  test("a split last week: the hole and every day after the file are gaps", () => {
    // Nov 9–15 split by a hole on Nov 11, the file ending Nov 15.
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
    expect(
      makePricer(split)
        .segments({ from: "2026-11-09", to: "2026-11-22" })
        .map((s) => [s.from, s.to, s.kind])
    ).toEqual([
      ["2026-11-09", "2026-11-10", "final"],
      ["2026-11-11", "2026-11-11", "gap"],
      ["2026-11-12", "2026-11-15", "final"],
      ["2026-11-16", "2026-11-22", "gap"],
    ]);
  });

  test("a day before the first period, a hole day and a day after the last: each a gap, unpriced, and out of $ per day and $ per commit", () => {
    // The weekly file with a hole on Nov 11; Oct 18 is before its first
    // period and Nov 16 after its last.
    const w = weeklyJson.periods;
    const holed = makePricer(
      parseRatesFiles([
        {
          name: "rates_FAKE_hole.json",
          text: JSON.stringify({
            ...weeklyJson,
            periods: [
              ...w.slice(0, 3),
              { ...w[3], valid_through: "2026-11-10" },
              { ...w[3], valid_from: "2026-11-12" },
            ],
          }),
        },
      ])
    );
    const gaps = ["2026-10-18", "2026-11-11", "2026-11-16"];
    const labels = Object.keys(w[3].rates);
    for (const day of gaps) {
      expect(holed.dayKind(day)).toBe("gap");
      expect(holed.segments({ from: day, to: day })).toEqual([
        { from: day, to: day, kind: "gap", period: null },
      ]);
      for (const label of labels) expect(holed.rate(label, day)).toBeNull();
      expect(holed.piece(LABEL, [day])).toEqual({
        rate: null,
        priced: 0,
        exact: true,
      });
    }
    // Days with data: the three gaps and three priced days, each with
    // pushes of its own. Oct 19 in the first week; Nov 10 and Nov 12, either
    // side of the hole, at the last week's rates.
    const side = [
      "2026-10-18",
      "2026-10-19",
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
      "2026-11-16",
    ];
    const pushes = side.map((_, i) => 30 + i);
    const rateAt = [null, rateIn(0), rateIn(3), null, rateIn(3), null];
    side.forEach((day, i) => expect(holed.rate(LABEL, day)).toBe(rateAt[i]));
    // $ per day divides by the priced days only; $ per commit by their
    // pushes only (the headline sums: drill.test's page facts).
    expect(pricedDays(holed, { days: side, pushes })).toEqual({
      days: 3,
      of: 6,
      pushes: pushes[1] + pushes[2] + pushes[4],
      note: "3 of 6 days priced",
    });
  });

  test("piece: exact inside a week, ≈ across a mid-week boundary, weighting only the days passed", () => {
    const inWeek = pricer.piece(LABEL, days("2026-11-03", "2026-11-07"));
    expect(inWeek).toEqual({
      rate: rateIn(2),
      priced: 1,
      exact: true,
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
    const gap = makePricer(parseRatesFiles([GAP]));
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
    });
    // Wholly in a gap: exactly unpriced.
    expect(gap.piece(LABEL, days("2026-11-02", "2026-11-08"))).toEqual({
      rate: null,
      priced: 0,
      exact: true,
    });
    // Days after the file are a gap like any other: a piece over them is
    // unpriced, and one reaching past the file's end is priced in part.
    expect(pricer.piece(LABEL, days("2026-11-16", "2026-11-18"))).toEqual({
      rate: null,
      priced: 0,
      exact: true,
    });
    expect(pricer.piece(LABEL, days("2026-11-14", "2026-11-17"))).toEqual({
      rate: rateIn(3),
      priced: 0.5,
      exact: false,
    });
    expect(pricer.piece(LABEL, [])).toEqual({
      rate: null,
      priced: 0,
      exact: true,
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
      ])
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
    const gap = makePricer(parseRatesFiles([GAP]));
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
    // Days after the file read as no rates, as a hole does.
    expect(pricer.coverageLine(range, 21_000)).toBe(
      "Rates Oct 19 – Nov 15 (Nov 9–15 provisional) · Nov 16–18 no rates · 21K h unpriced"
    );
    const gap = makePricer(parseRatesFiles([GAP]));
    expect(gap.coverageLine(range, 0)).toBe(
      "Rates Oct 19 – Nov 15 · Nov 2–8, Nov 16–18 no rates"
    );
    // Inside one final period, every hour priced: nothing to say.
    expect(
      pricer.coverageLine({ from: "2026-11-02", to: "2026-11-08" }, 0)
    ).toBeNull();
    const legacy = makePricer(
      parseRatesFiles([{ name: "r.json", text: '{"a": 1}' }])
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
  test("provisional days name their window; final days and days after the file add nothing", () => {
    const pricer = makePricer(parseRatesFiles([WEEKLY, META]));
    expect(pricingNotes(pricer, ["2026-11-10"])).toEqual([
      "Provisional: rates from Nov 9–13",
    ]);
    expect(pricingNotes(pricer, ["2026-11-10", "2026-11-17"])).toEqual([
      "Provisional: rates from Nov 9–13",
    ]);
    expect(pricingNotes(pricer, ["2026-11-03"])).toEqual([]);
    expect(pricingNotes(pricer, ["2026-11-17"])).toEqual([]);
    // Without the meta nothing is provisional.
    const plain = makePricer(parseRatesFiles([WEEKLY]));
    expect(pricingNotes(plain, ["2026-11-10", "2026-11-17"])).toEqual([]);
  });

  test("rates carried forward: provisional periods sharing a window say it once", () => {
    // Nov 16–22 lists Nov 9–15's rates, provisional from the same window.
    const w = weeklyJson.periods;
    const meta = JSON.parse(META.text);
    const pricer = makePricer(
      parseRatesFiles([
        {
          name: "rates_FAKE_forward.json",
          text: JSON.stringify({
            ...weeklyJson,
            periods: [
              ...w,
              {
                ...w[3],
                valid_from: "2026-11-16",
                valid_through: "2026-11-22",
              },
            ],
          }),
        },
        {
          name: "rates_FAKE_forward.meta.json",
          text: JSON.stringify({
            ...meta,
            periods: [
              ...meta.periods,
              { ...meta.periods[3], valid_from: "2026-11-16" },
            ],
          }),
        },
      ])
    );
    expect(pricer.dayKind("2026-11-17")).toBe("provisional");
    expect(pricingNotes(pricer, ["2026-11-10", "2026-11-17"])).toEqual([
      "Provisional: rates from Nov 9–13",
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
    const pricer = makePricer(weekly);
    // A week's total over its 7 days; a day before or after the file has
    // none.
    expect(dayTotals(pricer, "2026-11-10")).toEqual({
      aws_total: 200000 / 7,
      runner_nodes: 100000 / 7,
    });
    expect(dayTotals(pricer, "2026-11-17")).toBeNull();
    expect(dayTotals(pricer, "2026-10-18")).toBeNull();
    // A gap day has none.
    const gap = makePricer(parseRatesFiles([GAP]));
    expect(dayTotals(gap, "2026-11-04")).toBeNull();
    // Without totals, or a legacy file: none, and the files load as before.
    const bare = parseRatesFiles([
      {
        name: "b.json",
        text: JSON.stringify({ periods: [period(undefined)] }),
      },
    ]);
    expect(periodTotals(bare.periods[0])).toBeNull();
    expect(dayTotals(makePricer(bare), "2026-11-03")).toBeNull();
    const legacy = parseRatesFiles([{ name: "l.json", text: '{"a": 1}' }]);
    expect(dayTotals(makePricer(legacy), "2026-11-03")).toBeNull();
    // runner_nodes is optional.
    expect(one({ aws_total: 70 })).toBe("");
    const only = parseRatesFiles([
      {
        name: "o.json",
        text: JSON.stringify({ periods: [period({ aws_total: 70 })] }),
      },
    ]);
    expect(dayTotals(makePricer(only), "2026-11-03")).toEqual({
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
