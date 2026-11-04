import {
  plotOptions,
  plotSeries,
  tooltipText,
} from "components/targetDeterminator/TdTrends";
import fs from "fs";
import {
  breakageChunks,
  BREAKAGES_VALID_FROM,
  breakageStats,
  CHUNK_DAYS,
  ciSaved,
  CLAMP_DAYS,
  commitUrl,
  countedRange,
  DAY_MS,
  hoursText,
  MAX_CHUNKS,
  MIN_MAIN_RUNS,
  minutesText,
  NEW_TEST_DAYS,
  prUrl,
  rangeText,
  recallCurve,
  REVERT_WINDOW_DAYS,
  SAVINGS_VALID_FROM,
  sectionLimits,
  TD_CUT_PCT,
  TD_QUERIES,
  TD_SCOPE,
  wilsonInterval,
} from "lib/targetDeterminator";
import {
  type BreakageRow,
  mergeBreakageChunks,
  num,
  type RankRow,
  ratio,
  readTdQuery,
  type SavingsRow,
  totalError,
  totalRow,
} from "lib/targetDeterminatorRows";
import { buildPlot, TD_CHARTS } from "lib/targetDeterminatorTrends";
import path from "path";

function savings(partial: Partial<SavingsRow>): SavingsRow {
  return {
    grain: "total",
    bucket: "",
    config: "",
    jobs: 0,
    unmatched_jobs: 0,
    pr_hours: 0,
    est_full_hours: 0,
    pr_median_min: null,
    full_median_min: null,
    ...partial,
  };
}

function breakageTotal(partial: Partial<BreakageRow>): BreakageRow {
  return {
    grain: "total",
    landed_at: "",
    landing_sha: "",
    reverted_prs: [],
    revert_shas: [],
    reverted_at: "",
    revert_class: "",
    stack_size: 0,
    outcome: "unknown",
    window_closed: 0,
    breaking_tests: 0,
    test_configs: [],
    test_files: [],
    test_prs: [],
    test_outcomes: [],
    landed_prs: 0,
    events: 0,
    false_green: 0,
    signal_on_pr: 0,
    passed_on_pr: 0,
    td_skipped_any: 0,
    new_test: 0,
    not_in_pr_matrix: 0,
    landrace: 0,
    unknown: 0,
    other_reverts: 0,
    ghfirst_reverts: 0,
    ...partial,
  };
}

function hist(bucket: number, landings: number | string): RankRow {
  return {
    grain: "hist",
    bucket_pct: bucket,
    landings,
    failures: 0,
    inside_cut: 0,
    second_half: 0,
    median_pct: null,
    landed_at: "",
    sha: "",
    config: "",
    test_file: "",
    rank_pct: null,
  };
}

describe("num and ratio", () => {
  it("coerces ClickHouse 64-bit strings and rejects missing values", () => {
    expect(num("42")).toBe(42);
    expect(num(3.5)).toBe(3.5);
    expect(num(null)).toBeNull();
    expect(num(undefined)).toBeNull();
    expect(num("")).toBeNull();
    expect(num("abc")).toBeNull();
  });

  it("returns null for a zero or missing denominator", () => {
    expect(ratio(1, 4)).toBe(0.25);
    expect(ratio("3", "4")).toBe(0.75);
    expect(ratio(1, 0)).toBeNull();
    expect(ratio(1, "0")).toBeNull();
    expect(ratio(null, 4)).toBeNull();
    expect(ratio(1, undefined)).toBeNull();
  });
});

describe("ciSaved", () => {
  it("is 1 - PR hours / estimated full hours, with hours saved", () => {
    const saved = ciSaved(savings({ pr_hours: "25", est_full_hours: "100" }));
    expect(saved).toEqual({ share: 0.75, hoursSaved: 75 });
  });

  it("is null on an empty window or a missing row", () => {
    expect(ciSaved(savings({ pr_hours: 0, est_full_hours: 0 }))).toBeNull();
    expect(ciSaved(undefined)).toBeNull();
    expect(ciSaved(savings({ pr_hours: 5, est_full_hours: null }))).toBeNull();
  });
});

describe("wilsonInterval", () => {
  it("brackets the observed share", () => {
    const interval = wilsonInterval(10, 100)!;
    expect(interval.low).toBeCloseTo(0.0552, 3);
    expect(interval.high).toBeCloseTo(0.1744, 3);
  });

  it("is not degenerate at zero or all successes and stays in [0, 1]", () => {
    const none = wilsonInterval(0, 20)!;
    expect(none.low).toBe(0);
    expect(none.high).toBeGreaterThan(0.1);
    const all = wilsonInterval(20, 20)!;
    expect(all.high).toBe(1);
    expect(all.low).toBeLessThan(0.9);
  });

  it("is null without trials or with impossible counts", () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(wilsonInterval(3, 2)).toBeNull();
    expect(wilsonInterval(-1, 2)).toBeNull();
  });
});

describe("breakageStats", () => {
  it("computes share, interval, rate per 1,000 landings and recall", () => {
    const stats = breakageStats(
      breakageTotal({
        landed_prs: "2000",
        events: "20",
        false_green: "2",
        signal_on_pr: "4",
        passed_on_pr: "2",
        td_skipped_any: "3",
        new_test: "2",
        not_in_pr_matrix: "2",
        landrace: "2",
        unknown: "4",
      })
    );
    expect(stats.falseGreens).toBe(2);
    expect(stats.known).toBe(16);
    expect(stats.unknown).toBe(4);
    expect(stats.share).toBe(2 / 16);
    expect(stats.interval).toEqual(wilsonInterval(2, 16));
    expect(stats.perThousandLandings).toBe(1);
    expect(stats.ranOnPr).toBe(6);
    expect(stats.recallBase).toBe(8);
    expect(stats.recall).toBe(6 / 8);
    expect(stats.tdSkippedAny).toBe(3);
  });

  it("leaves unknown events out of every denominator", () => {
    const stats = breakageStats(
      breakageTotal({ events: 5, unknown: 5, landed_prs: 100 })
    );
    expect(stats.known).toBe(0);
    expect(stats.share).toBeNull();
    expect(stats.interval).toBeNull();
    expect(stats.recall).toBeNull();
    expect(stats.perThousandLandings).toBe(0);
  });

  it("never has a negative known count", () => {
    const stats = breakageStats(breakageTotal({ events: 2, unknown: 5 }));
    expect(stats.known).toBe(0);
    expect(stats.share).toBeNull();
  });

  it("has no rates on an empty window or a missing row", () => {
    for (const row of [breakageTotal({}), undefined]) {
      const stats = breakageStats(row);
      expect(stats.share).toBeNull();
      expect(stats.recall).toBeNull();
      expect(stats.perThousandLandings).toBeNull();
    }
  });
});

describe("recallCurve", () => {
  it("accumulates the per-landing histogram into a 0-100 curve", () => {
    const curve = recallCurve([
      hist(0, "2"),
      hist(10, 1),
      hist(30, 1),
      { ...hist(5, 9), grain: "total" },
      { ...hist(7, 9), grain: "landing" },
    ]);
    expect(curve).toHaveLength(101);
    expect(curve[0]).toEqual({ pct: 0, share: 0 });
    expect(curve[1]).toEqual({ pct: 1, share: 0.5 });
    expect(curve[10].share).toBe(0.5);
    expect(curve[11].share).toBe(0.75);
    expect(curve[25].share).toBe(0.75);
    expect(curve[31].share).toBe(1);
    expect(curve[100]).toEqual({ pct: 100, share: 1 });
  });

  it("is empty without landings and ignores out-of-range buckets", () => {
    expect(recallCurve([])).toEqual([]);
    expect(recallCurve([hist(4, 0)])).toEqual([]);
    expect(recallCurve([hist(100, 3), hist(-1, 3)])).toEqual([]);
  });
});

describe("rows and text", () => {
  it("finds the total row and reports a missing one", () => {
    const rows = [{ grain: "day" }, { grain: "total" }];
    expect(totalRow(rows)).toBe(rows[1]);
    expect(totalRow([rows[0]])).toBeUndefined();
    expect(totalError("q", { loading: false }, undefined)).toBe(
      "q: no total row"
    );
    expect(totalError("q", { loading: true }, undefined)).toBeUndefined();
    expect(totalError("q", { loading: false, error: "e" }, rows[1])).toBe("e");
  });

  it("formats minutes and hours, with a dash for missing values", () => {
    expect(minutesText("29.4")).toBe("29 min");
    expect(minutesText(null)).toBe("-");
    expect(hoursText(50.94)).toBe("50.9 h");
    expect(hoursText(475874.8)).toBe("475,875 h");
    expect(hoursText(undefined)).toBe("-");
  });

  it("builds links only from PR numbers and SHAs", () => {
    expect(prUrl("123")).toBe("https://github.com/pytorch/pytorch/pull/123");
    expect(prUrl("12a")).toBeUndefined();
    expect(prUrl(0)).toBeUndefined();
    expect(prUrl(1.5)).toBeUndefined();
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(commitUrl(sha)).toBe(
      `https://github.com/pytorch/pytorch/commit/${sha}`
    );
    expect(commitUrl("javascript:alert(1)")).toBeUndefined();
    expect(commitUrl(undefined)).toBeUndefined();
  });
});

describe("readTdQuery", () => {
  it("names the failing query", () => {
    const state = readTdQuery("td_x", undefined, new Error("boom"));
    expect(state).toEqual({ loading: false, error: "td_x: boom", rows: [] });
  });

  it("is loading until data arrives and rejects non-array answers", () => {
    expect(readTdQuery("td_x", undefined, undefined).loading).toBe(true);
    expect(readTdQuery("td_x", { error: "x" }, undefined).error).toBe(
      "td_x: unexpected query response"
    );
    expect(readTdQuery("td_x", [{ a: 1 }], undefined)).toEqual({
      loading: false,
      rows: [{ a: 1 }],
    });
  });
});

const ms = (time: string) => Date.parse(`${time}Z`);
const day0 = (day: string) => ms(`${day}T00:00:00.000`);
const pick = (start: string, stop: string) => ({
  startTime: `${start}T00:00:00.000`,
  stopTime: `${stop}T00:00:00.000`,
});
const NOW = ms("2026-11-04T12:00:00.000");

describe("countedRange", () => {
  const limits = sectionLimits(NOW);

  it("starts at the valid-from day and says why", () => {
    const range = countedRange(
      pick("2026-06-01", "2026-08-01"),
      limits.savings,
      NOW
    );
    expect(range.startTime).toBe(`${SAVINGS_VALID_FROM}T00:00:00.000`);
    expect(range.stopTime).toBe("2026-08-01T00:00:00.000");
    expect(range.empty).toBe(false);
    expect(range.note).toBe(limits.savings.validReason);
    expect(rangeText(range)).toBe(`${SAVINGS_VALID_FROM} to 2026-07-31`);
  });

  it("clamps to the query's width before the picked stop", () => {
    const range = countedRange(
      pick("2026-01-01", "2026-03-01"),
      { clampDays: 30 },
      NOW
    );
    expect(range.startTime).toBe("2026-01-30T00:00:00.000");
    expect(range.note).toBe("This section reads at most 30 days at a time.");
  });

  it("keeps the picked stop as the query stop and ends the data at now", () => {
    const range = countedRange(
      pick("2026-10-05", "2026-11-05"),
      limits.savings,
      NOW
    );
    expect(range.startTime).toBe("2026-10-05T00:00:00.000");
    expect(range.stopTime).toBe("2026-11-05T00:00:00.000");
    expect(range.end).toBe(NOW);
    expect(range.note).toBeUndefined();
    expect(rangeText(range)).toBe("2026-10-05 to 2026-11-04");
  });

  it("counts retention from whole UTC days", () => {
    expect(limits.ranks.validFrom).toBe(day0("2026-11-04") - 89 * DAY_MS);
    expect(limits.stability.validFrom).toBe(day0("2026-10-06"));
    const range = countedRange(
      pick("2026-10-05", "2026-11-05"),
      limits.stability,
      NOW
    );
    expect(range.startTime).toBe("2026-10-06T00:00:00.000");
    expect(range.note).toBe(limits.stability.validReason);
  });

  it("is empty before the valid-from day, in the future and inverted", () => {
    const before = countedRange(
      pick("2026-05-01", "2026-07-01"),
      limits.breakages,
      NOW
    );
    expect(before.empty).toBe(true);
    expect(before.note).toBe(limits.breakages.validReason);
    expect(
      countedRange(pick("2026-11-10", "2026-11-20"), limits.savings, NOW).empty
    ).toBe(true);
    expect(
      countedRange(pick("2026-10-20", "2026-10-10"), limits.savings, NOW).empty
    ).toBe(true);
  });
});

describe("breakageChunks", () => {
  const anchor = day0(BREAKAGES_VALID_FROM);
  const chunked = (start: string, stop: string, now = NOW) =>
    breakageChunks(
      countedRange(pick(start, stop), sectionLimits(now).breakages, now),
      now
    );

  function expectTiling(start: string, stop: string, now: number) {
    const { chunks, range } = chunked(start, stop, now);
    expect(chunks[0].startTime).toBe(range.startTime);
    expect(chunks[chunks.length - 1].stopTime).toBe(range.stopTime);
    chunks.forEach((chunk, i) => {
      const from = ms(chunk.startTime);
      const to = ms(chunk.stopTime);
      expect(to).toBeGreaterThan(from);
      expect(to - from).toBeLessThanOrEqual(90 * DAY_MS);
      if (i > 0) {
        expect(chunk.startTime).toBe(chunks[i - 1].stopTime);
        expect((from - anchor) % (90 * DAY_MS)).toBe(0);
      }
    });
    return chunks;
  }

  it("tiles the range on a 90-day grid anchored at the valid-from day", () => {
    const later = ms("2027-12-01T00:00:00.000");
    const chunks = expectTiling("2026-09-09", "2027-03-28", later);
    expect(chunks.map((c) => c.label)).toEqual([
      "2026-09-09 to 2026-12-07",
      "2026-12-08 to 2027-03-07",
      "2027-03-08 to 2027-03-27",
    ]);
    expect(expectTiling("2026-10-01", "2027-06-15", later)).toHaveLength(4);
  });

  it("starts mid-cell and skips cells that start after now", () => {
    const { chunks } = chunked("2026-10-01", "2026-11-05");
    expect(chunks).toEqual([
      {
        startTime: "2026-10-01T00:00:00.000",
        stopTime: "2026-11-05T00:00:00.000",
        label: "2026-10-01 to 2026-11-04",
      },
    ]);
    const now = ms("2026-12-07T12:00:00.000");
    const late = chunked("2026-11-01", "2026-12-20", now).chunks;
    expect(late.map((c) => c.stopTime)).toEqual(["2026-12-08T00:00:00.000"]);
  });

  it("has no chunks for an empty, inverted or future range", () => {
    expect(chunked("2026-05-01", "2026-07-01").chunks).toEqual([]);
    expect(chunked("2026-10-20", "2026-10-10").chunks).toEqual([]);
    expect(chunked("2026-11-10", "2026-12-10").chunks).toEqual([]);
  });

  it("keeps the newest MAX_CHUNKS cells and narrows the range", () => {
    const later = ms("2029-01-01T00:00:00.000");
    const { chunks, range } = chunked("2026-09-09", "2028-09-01", later);
    expect(chunks).toHaveLength(MAX_CHUNKS);
    expect(range.startTime).toBe(chunks[0].startTime);
    expect((ms(range.startTime) - anchor) % (90 * DAY_MS)).toBe(0);
    expect(range.note).toBe(
      `This section reads at most ${MAX_CHUNKS * 90} days at a time.`
    );
  });
});

describe("mergeBreakageChunks", () => {
  const chunks = [
    { startTime: "a", stopTime: "b", label: "2026-09-09 to 2026-12-07" },
    { startTime: "b", stopTime: "c", label: "2026-12-08 to 2027-01-01" },
  ];
  const event = (sha: string) =>
    breakageTotal({ grain: "event", landing_sha: sha });
  const answer = (rows: BreakageRow[]) => ({ loading: false, rows });

  it("sums the totals of every chunk, string counts included", () => {
    const merged = mergeBreakageChunks("td_x", chunks, [
      answer([
        breakageTotal({ events: "3", false_green: "1", landed_prs: "100" }),
        event("a1"),
      ]),
      answer([
        event("b1"),
        breakageTotal({ events: 2, false_green: "2", landed_prs: "50" }),
      ]),
    ]);
    expect(merged.error).toBeUndefined();
    expect(merged.total?.events).toBe(5);
    expect(merged.total?.false_green).toBe(3);
    expect(merged.total?.landed_prs).toBe(150);
    expect(merged.total?.grain).toBe("total");
    expect(merged.rows.map((r) => r.landing_sha)).toEqual(["a1", "b1"]);
  });

  it("fails on a chunk without exactly one total row, naming its dates", () => {
    const merged = mergeBreakageChunks("td_x", chunks, [
      answer([breakageTotal({})]),
      answer([event("b1")]),
    ]);
    expect(merged.error).toBe(
      "td_x (2026-12-08 to 2027-01-01): 0 total rows, expected 1"
    );
    expect(merged.tileError).toBe(merged.error);
    expect(merged.total).toBeUndefined();
  });

  it("fails on a failed chunk even while another loads", () => {
    const merged = mergeBreakageChunks("td_x", chunks, [
      { loading: true, rows: [] },
      { loading: false, error: "td_x: boom", rows: [] },
    ]);
    expect(merged.error).toBe("td_x: boom (2026-12-08 to 2027-01-01)");
  });

  it("loads until every chunk answered and needs a slot per chunk", () => {
    expect(
      mergeBreakageChunks("td_x", chunks, [
        answer([breakageTotal({})]),
        { loading: true, rows: [] },
      ]).loading
    ).toBe(true);
    expect(
      mergeBreakageChunks("td_x", chunks, [answer([breakageTotal({})])]).error
    ).toBe("td_x: more chunks than query slots");
    expect(mergeBreakageChunks("td_x", [], []).total).toBeUndefined();
  });
});

describe("trend charts", () => {
  const window = (start: string, end: string) => ({
    start: ms(start),
    end: ms(end),
  });
  const savingsRow = (
    grain: SavingsRow["grain"],
    bucket: string,
    partial: Partial<SavingsRow>
  ) => savings({ grain, bucket, ...partial });

  it("fills counts with 0 and leaves medians as gaps, on UTC days", () => {
    const rows = [
      savingsRow("day", "2026-10-01", {
        pr_hours: "2",
        jobs: "4",
        pr_median_min: "20",
      }),
      savingsRow("day", "2026-10-03", {
        pr_hours: "3",
        jobs: "0",
        pr_median_min: 0,
      }),
      savingsRow("week", "2026-09-28", { pr_hours: "99" }),
      savingsRow("total", "", { pr_hours: "5" }),
    ];
    const w = window("2026-10-01T00:00:00.000", "2026-10-04T12:00:00.000");
    const hours = buildPlot(TD_CHARTS.ciSaved, rows, "day", w);
    expect(hours.buckets.map((b) => b.key)).toEqual([
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ]);
    expect(hours.states).toEqual(["full", "full", "full", "partial"]);
    expect(hours.values[0]).toEqual([2, 0, 3, 0]);
    const sum = hours.values[0].reduce<number>((t, v) => t + (v ?? 0), 0);
    expect(sum).toBe(num(totalRow(rows)?.pr_hours));
    const medians = buildPlot(TD_CHARTS.typicalJob, rows, "day", w);
    expect(medians.values[0]).toEqual([20, null, null, null]);
  });

  it("reads the week rows on ISO Monday buckets, partial at both ends", () => {
    const rows = [
      savingsRow("week", "2026-09-28", { pr_hours: 1 }),
      savingsRow("week", "2026-10-12", { pr_hours: 2 }),
      savingsRow("day", "2026-10-13", { pr_hours: 50 }),
    ];
    const plot = buildPlot(
      TD_CHARTS.ciSaved,
      rows,
      "week",
      window("2026-10-01T00:00:00.000", "2026-10-20T00:00:00.000")
    );
    expect(plot.buckets.map((b) => b.key)).toEqual([
      "2026-09-28",
      "2026-10-05",
      "2026-10-12",
      "2026-10-19",
    ]);
    expect(plot.states).toEqual(["partial", "full", "full", "partial"]);
    expect(plot.values[0]).toEqual([1, 0, 2, 0]);
  });

  it("buckets closed breakages by landing time and leaves recent ones uncounted", () => {
    const closed = (landed: string, outcome: BreakageRow["outcome"]) =>
      breakageTotal({
        grain: "event",
        landed_at: landed,
        outcome,
        window_closed: "1",
      });
    const rows = [
      closed("2026-10-04 23:59:59.000", "false_green"),
      closed("2026-10-05 00:00:00.000", "false_green"),
      closed("2026-10-06 10:00:00.000", "signal_on_pr"),
      breakageTotal({
        grain: "event",
        landed_at: "2026-10-06 11:00:00.000",
        outcome: "false_green",
        window_closed: 0,
      }),
      breakageTotal({ false_green: "2", events: "3" }),
    ];
    const w = {
      ...window("2026-10-01T00:00:00.000", "2026-10-21T00:00:00.000"),
      countedUntil: ms("2026-10-14T12:00:00.000"),
    };
    const weekly = buildPlot(TD_CHARTS.falseGreens, rows, "week", w);
    expect(weekly.buckets.map((b) => b.key)).toEqual([
      "2026-09-28",
      "2026-10-05",
      "2026-10-12",
      "2026-10-19",
    ]);
    expect(weekly.states).toEqual(["partial", "full", "partial", "pending"]);
    expect(weekly.values[0]).toEqual([1, 1, 0, null]);
    const daily = buildPlot(TD_CHARTS.traced, rows, "day", w);
    const total = daily.values.flat().reduce<number>((t, v) => t + (v ?? 0), 0);
    expect(total).toBe(num(totalRow(rows)?.events));
    expect(daily.values[0][3]).toBe(1);
    expect(daily.values[0][4]).toBe(1);
    expect(daily.states[13]).toBe("partial");
    expect(daily.values[0][14]).toBeNull();
  });

  it("leaves buckets older than a truncated list uncharted", () => {
    const landing = (landed: string, inside: number) => ({
      ...hist(0, 1),
      grain: "landing" as const,
      landed_at: landed,
      inside_cut: inside,
    });
    const rows = [
      landing("2026-10-03 08:00:00.000", 1),
      landing("2026-10-04 08:00:00.000", 0),
    ];
    const plot = buildPlot(TD_CHARTS.caught, rows, "day", {
      ...window("2026-10-01T00:00:00.000", "2026-10-05T00:00:00.000"),
      countedFrom: ms("2026-10-03T08:00:00.000"),
    });
    expect(plot.states).toEqual(["truncated", "truncated", "partial", "full"]);
    expect(plot.values).toEqual([
      [null, null, 1, 0],
      [null, null, 0, 1],
    ]);
  });

  it("charts shares as gaps without pairs and TTRS weekly", () => {
    const churn = [
      { grain: "day", bucket: "2026-10-01", pairs: "4", identical_pairs: "3" },
      { grain: "day", bucket: "2026-10-02", pairs: "0", identical_pairs: "0" },
    ];
    const w = window("2026-10-01T00:00:00.000", "2026-10-03T00:00:00.000");
    expect(buildPlot(TD_CHARTS.samePicks, churn, "day", w).values).toEqual([
      [75, null],
    ]);
    const ttrs = buildPlot(
      TD_CHARTS.ttrs,
      [{ bucket: "2026-09-28", custom: "12" }],
      "day",
      window("2026-10-01T00:00:00.000", "2026-10-13T00:00:00.000")
    );
    expect(ttrs.granularity).toBe("week");
    expect(ttrs.values).toEqual([[12, null, null]]);
  });

  it("marks partial and uncounted buckets on the chart and in the tooltip", () => {
    const rows = [
      breakageTotal({
        grain: "event",
        landed_at: "2026-10-01 10:00:00.000",
        outcome: "false_green",
        window_closed: 1,
      }),
    ];
    const plot = buildPlot(TD_CHARTS.recall, rows, "day", {
      ...window("2026-10-01T06:00:00.000", "2026-10-04T00:00:00.000"),
      countedUntil: ms("2026-10-03T00:00:00.000"),
    });
    const series = plotSeries(TD_CHARTS.recall, plot);
    expect(series).toHaveLength(2);
    expect(series[0].stack).toBe("Total");
    expect(series[1].data[0]).toEqual({
      value: [day0("2026-10-01"), 1],
      itemStyle: { opacity: 0.45 },
      symbol: "emptyCircle",
      symbolSize: 8,
    });
    expect(series[0].markArea?.data).toEqual([
      [
        { name: "Not yet counted", xAxis: day0("2026-10-03") - DAY_MS / 2 },
        { xAxis: day0("2026-10-03") + DAY_MS / 2 },
      ],
    ]);
    expect(series[1].markArea).toBeUndefined();
    const partial = tooltipText(TD_CHARTS.recall, plot, 0);
    expect(partial).toContain("Partial bucket");
    expect(partial).toContain("False greens: 1");
    expect(partial).toContain("Total: 1");
    expect(tooltipText(TD_CHARTS.recall, plot, 2)).toContain("Not yet counted");
    expect(plotOptions(TD_CHARTS.recall, plot).xAxis).toEqual({
      min: day0("2026-10-01") - DAY_MS / 2,
      max: day0("2026-10-03") + DAY_MS / 2,
    });
  });
});

const quoted = (values: string[]) => values.map((v) => `'${v}'`);
const WORKFLOWS = quoted(TD_SCOPE.tdWorkflows).join(", ");
const PREFIXES = quoted(TD_SCOPE.tdWorkflowPrefixes);
const MARKERS = quoted(TD_SCOPE.noTdBuildMarkers).join(", ");
const WINDOW = { startTime: "DateTime64(3)", stopTime: "DateTime64(3)" };

interface Contract {
  columns: string[];
  params: Record<string, string>;
  defaults?: Record<string, unknown>;
  horizonDays: number;
  grains: string[];
  literals: string[];
}

const CONTRACTS: Record<string, Contract> = {
  [TD_QUERIES.savings]: {
    columns: [
      "grain",
      "bucket",
      "config",
      "jobs",
      "unmatched_jobs",
      "pr_hours",
      "est_full_hours",
      "pr_median_min",
      "full_median_min",
    ],
    params: WINDOW,
    horizonDays: CLAMP_DAYS.savings,
    grains: ["day", "week", "config", "total"],
    literals: [
      WORKFLOWS,
      ...PREFIXES,
      MARKERS,
      `>= ${MIN_MAIN_RUNS} AS matched`,
    ],
  },
  [TD_QUERIES.pushWait]: {
    columns: [
      "grain",
      "bucket",
      "pushes",
      "actual_ttg_median_min",
      "est_ttg_median_min",
      "saved_median_min",
      "hours_per_push",
      "est_hours_per_push",
    ],
    params: WINDOW,
    horizonDays: CLAMP_DAYS.pushWait,
    grains: ["day", "week", "total"],
    literals: [
      "workflow_name = 'pull'",
      MARKERS,
      `>= ${MIN_MAIN_RUNS} AS matched`,
    ],
  },
  [TD_QUERIES.breakages]: {
    columns: [
      "grain",
      "landed_at",
      "landing_sha",
      "reverted_prs",
      "revert_shas",
      "reverted_at",
      "revert_class",
      "stack_size",
      "outcome",
      "window_closed",
      "breaking_tests",
      "test_configs",
      "test_files",
      "test_prs",
      "test_outcomes",
      "landed_prs",
      "events",
      "false_green",
      "signal_on_pr",
      "passed_on_pr",
      "td_skipped_any",
      "new_test",
      "not_in_pr_matrix",
      "landrace",
      "unknown",
      "other_reverts",
      "ghfirst_reverts",
    ],
    params: { ...WINDOW, tdWorkflows: "Array(String)" },
    defaults: { tdWorkflows: TD_SCOPE.tdWorkflows },
    horizonDays: CHUNK_DAYS,
    grains: ["event", "total"],
    literals: [
      ...PREFIXES,
      MARKERS,
      `toIntervalDay(${REVERT_WINDOW_DAYS})`,
      `toIntervalDay(${NEW_TEST_DAYS})`,
    ],
  },
  [TD_QUERIES.ranks]: {
    columns: [
      "grain",
      "bucket_pct",
      "landings",
      "failures",
      "inside_cut",
      "second_half",
      "median_pct",
      "landed_at",
      "sha",
      "config",
      "test_file",
      "rank_pct",
    ],
    params: WINDOW,
    horizonDays: CLAMP_DAYS.ranks,
    grains: ["hist", "total", "landing"],
    literals: [WORKFLOWS, ...PREFIXES, MARKERS, `intDiv(${TD_CUT_PCT} * `],
  },
  [TD_QUERIES.churn]: {
    columns: [
      "grain",
      "bucket",
      "pairs",
      "identical_pairs",
      "changed_median_pct",
      "prs",
    ],
    params: WINDOW,
    horizonDays: CLAMP_DAYS.churn,
    grains: ["day", "week", "total"],
    literals: ["workflow_name = 'pull'", MARKERS],
  },
};

describe("clamp widths", () => {
  it("match the SQL clamps the contracts check", () => {
    expect(CLAMP_DAYS).toEqual({
      savings: 365,
      pushWait: 365,
      breakages: 90,
      ranks: 90,
      churn: 30,
      ttrs: 30,
    });
    expect(CHUNK_DAYS).toBe(90);
  });
});

const queriesDir = path.resolve(__dirname, "..", "clickhouse_queries");

// An output column is either aliased (`... AS col`) or selected bare on a line
// of its own (`col,` or `t.col`).
function hasOutputColumn(sql: string, column: string): boolean {
  return (
    new RegExp(`\\bAS\\s+\`?${column}\`?(?![\\w])`, "i").test(sql) ||
    new RegExp(`^\\s*(\\w+\\.)?${column}\\s*,?\\s*$`, "m").test(sql)
  );
}

describe.each(Object.entries(CONTRACTS))("%s contract", (name, contract) => {
  const dir = path.join(queriesDir, name);
  const read = (file: string) => fs.readFileSync(path.join(dir, file), "utf8");

  it("outputs every pinned column", () => {
    const sql = read("query.sql");
    const missing = contract.columns.filter((c) => !hasOutputColumn(sql, c));
    expect(missing).toEqual([]);
  });

  it("takes only the page's parameters, with the page's defaults", () => {
    const json = JSON.parse(read("params.json"));
    expect(json.params).toEqual(contract.params);
    expect(json.defaults ?? {}).toEqual(contract.defaults ?? {});
  });

  it("hardcodes the page's constants and clamps the window", () => {
    const sql = read("query.sql");
    const missing = contract.literals.filter((l) => !sql.includes(l));
    expect(missing).toEqual([]);
    const days = contract.horizonDays;
    expect(sql).toMatch(
      new RegExp(
        `window_end - (INTERVAL ${days} DAY|toIntervalDay\\(${days}\\))`
      )
    );
  });

  it("returns the grains the page reads, and no others", () => {
    const sql = read("query.sql");
    const missing = contract.grains.filter((g) => !sql.includes(`'${g}'`));
    expect(missing).toEqual([]);
    expect(sql).not.toContain("'miss'");
  });

  it("binds only its declared parameters and caps its own cost", () => {
    const sql = read("query.sql");
    const placeholders = Object.fromEntries(
      [...sql.matchAll(/\{(\w+):\s*([^}]+)\}/g)].map((m) => [m[1], m[2]])
    );
    expect(placeholders).toEqual(contract.params);
    expect(sql).toMatch(/SETTINGS max_execution_time = 60, max_threads = 8\b/);
    // A caller-sized array inside a per-row lambda would let one request
    // scale its own CPU cost; tdWorkflows may only feed a set lookup.
    const arrayUses = sql.match(/\{tdWorkflows:/g) ?? [];
    if (arrayUses.length > 0) {
      expect(arrayUses).toHaveLength(1);
      expect(sql).toContain("workflow_name IN {tdWorkflows: Array(String)}");
    }
  });
});
