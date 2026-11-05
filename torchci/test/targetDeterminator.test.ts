import BreakagesSection from "components/targetDeterminator/BreakagesSection";
import RankingSection from "components/targetDeterminator/RankingSection";
import StabilitySection from "components/targetDeterminator/StabilitySection";
import {
  plotOptions,
  plotSeries,
  TdChartsState,
  tooltipText,
} from "components/targetDeterminator/TdTrends";
import fs from "fs";
import { NO_DATA_IN_WINDOW } from "lib/greenlight/qualityFigures";
import {
  breakageStats,
  CHANGE_BUCKET_PCT,
  ciSaved,
  CLAMP_DAYS,
  countedRange,
  DAY_MS,
  histMedian,
  hoursText,
  JOB_NAMES_VALID_FROM,
  landingsMissing,
  MIN_MAIN_RUNS,
  minutesText,
  NEW_TEST_CHECK_FROM,
  NEW_TEST_DAYS,
  NOTHING_TO_MEASURE,
  PENDING_NOTE,
  rangeText,
  RANKS_DATA_FROM,
  REVERT_WINDOW_DAYS,
  sectionLimits,
  STABILITY_DATA_FROM,
  STABILITY_LOOK_BACK_DAYS,
  TD_CUT_PCT,
  TD_QUERIES,
  TD_SCOPE,
  type TdParams,
} from "lib/targetDeterminator";
import {
  type Chunk,
  CHUNKED_SECTIONS,
  type ChunkedSection,
  HELD_SLOT,
  MAX_CHUNKS,
  mergeChunks,
  rangeChunks,
  sectionChunks,
  slotStarts,
  useChunkedTdQuery,
} from "lib/targetDeterminatorChunks";
import {
  type BreakageRow,
  type ChurnRow,
  num,
  type RankRow,
  ratio,
  readTdQuery,
  type SavingsRow,
  type TdQueryState,
  totalError,
  totalRow,
} from "lib/targetDeterminatorRows";
import { buildPlot, TD_CHARTS } from "lib/targetDeterminatorTrends";
import path from "path";
import { ComponentType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The chunk slots fetch through useClickHouseAPI. The mock records every query
// a slot sends and answers it with respond.
type MockAnswer = { data?: unknown; error?: unknown };
const mockApi = {
  calls: [] as { name: string; startTime: string; stopTime: string }[],
  respond: (_name: string, _startTime: string): MockAnswer => ({}),
};
jest.mock("lib/GeneralUtils", () => ({
  useClickHouseAPI: (
    name: string,
    parameters: Record<string, unknown>,
    condition: boolean
  ) => {
    if (!condition) {
      return { data: undefined, error: undefined };
    }
    const startTime = String(parameters.startTime);
    mockApi.calls.push({
      name,
      startTime,
      stopTime: String(parameters.stopTime),
    });
    return mockApi.respond(name, startTime);
  },
}));

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

function rank(partial: Partial<RankRow>): RankRow {
  return {
    grain: "total",
    bucket_pct: 0,
    landings: 0,
    failures: 0,
    inside_cut: 0,
    second_half: 0,
    median_pct: null,
    landed_at: "",
    sha: "",
    config: "",
    test_file: "",
    rank_pct: null,
    ...partial,
  };
}

function churn(partial: Partial<ChurnRow>): ChurnRow {
  return {
    grain: "total",
    bucket: "",
    bucket_pct: 0,
    pairs: 0,
    identical_pairs: 0,
    changed_median_pct: 0,
    prs: 0,
    ...partial,
  };
}

const histRow = (bucket: number, pairs: number | string) =>
  churn({ grain: "hist", bucket_pct: bucket, pairs });

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
  it("is 1 - PR hours / estimated full hours", () => {
    const saved = ciSaved(savings({ pr_hours: "25", est_full_hours: "100" }));
    expect(saved).toBe(0.75);
  });

  it("is null on an empty window or a missing row", () => {
    expect(ciSaved(savings({ pr_hours: 0, est_full_hours: 0 }))).toBeNull();
    expect(ciSaved(undefined)).toBeNull();
    expect(ciSaved(savings({ pr_hours: 5, est_full_hours: null }))).toBeNull();
  });
});

describe("breakageStats", () => {
  it("computes recall over the breakages whose tests could run on the PR", () => {
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
    expect(stats).toEqual({ falseGreens: 2, recall: 6 / 8, recallBase: 8 });
  });

  it("reads a merged total that holds only the summed counts", () => {
    const stats = breakageStats({
      events: 4,
      false_green: 1,
      signal_on_pr: 0,
      passed_on_pr: 3,
    });
    expect(stats).toEqual({ falseGreens: 1, recall: 0.75, recallBase: 4 });
  });

  it("has no recall without a breakage whose tests could run on the PR", () => {
    for (const row of [
      breakageTotal({ events: 5, unknown: 3, landrace: 2 }),
      breakageTotal({}),
      undefined,
    ]) {
      const stats = breakageStats(row);
      expect(stats.falseGreens).toBe(0);
      expect(stats.recallBase).toBe(0);
      expect(stats.recall).toBeNull();
    }
  });
});

describe("histMedian", () => {
  const median = (rows: ChurnRow[]) =>
    histMedian(rows, "bucket_pct", "pairs", CHANGE_BUCKET_PCT);

  it("is null without counted hist rows", () => {
    expect(median([])).toBeNull();
    expect(
      median([churn({ pairs: 9 }), churn({ grain: "day", pairs: 9 })])
    ).toBeNull();
    expect(median([histRow(4.5, 0), histRow(2, "")])).toBeNull();
  });

  it("is the middle of a single bucket", () => {
    expect(median([histRow(7.3, "12")])).toBeCloseTo(7.35, 10);
  });

  it("interpolates inside the bucket that holds the median", () => {
    expect(
      median([histRow(4.4, 30), histRow(4.3, 10), histRow(9, 20)])
    ).toBeCloseTo(4.4 + (0.1 * (30 - 10)) / 30, 10);
    expect(
      median([histRow(0.3, "3"), histRow(0.7, 1), histRow(5, 1)])
    ).toBeCloseTo(0.3 + (0.1 * 2.5) / 3, 10);
  });

  it("lands on a bucket edge when half the items lie below it", () => {
    expect(median([histRow(1, 2), histRow(2, 2)])).toBeCloseTo(1.1, 10);
    expect(median([histRow(0, 5), histRow(12.1, 5)])).toBeCloseTo(0.1, 10);
  });

  it("adds up buckets repeated across chunks", () => {
    expect(
      median([histRow(0.5, 1), histRow(4.5, 2), histRow(0.5, "1")])
    ).toBeCloseTo(0.6, 10);
  });
});

describe("landingsMissing", () => {
  const answer = (rows: RankRow[]) => ({ loading: false, rows });
  const landing = rank({ grain: "landing", landings: 1 });

  it("is true when a chunk lists fewer landings than it counted", () => {
    const full = answer([rank({ landings: "1" }), landing]);
    const cut = answer([rank({ landings: "3" }), landing, landing]);
    expect(landingsMissing([full])).toBe(false);
    expect(landingsMissing([full, cut])).toBe(true);
  });

  it("is false for slots that are held, unused or still loading", () => {
    expect(
      landingsMissing([HELD_SLOT, { loading: false, rows: [] }, HELD_SLOT])
    ).toBe(false);
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

  it("is not loading when the query is not enabled", () => {
    expect(readTdQuery("td_x", undefined, undefined, false)).toEqual({
      loading: false,
      rows: [],
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
    expect(range.params).toEqual({
      startTime: `${JOB_NAMES_VALID_FROM}T00:00:00.000`,
      stopTime: "2026-08-01T00:00:00.000",
    });
    expect(range.empty).toBe(false);
    expect(range.note).toBe(limits.savings.validReason);
    expect(rangeText(range)).toBe(`${JOB_NAMES_VALID_FROM} to 2026-07-31`);
    const breakages = countedRange(
      pick("2026-06-01", "2026-08-01"),
      limits.breakages,
      NOW
    );
    expect(breakages.params).toEqual(range.params);
    expect(breakages.note).toBe(limits.breakages.validReason);
  });

  it("clamps to the query's width before the picked stop", () => {
    const range = countedRange(
      pick("2026-01-01", "2026-03-01"),
      { clampDays: 30 },
      NOW
    );
    expect(range.params?.startTime).toBe("2026-01-30T00:00:00.000");
    expect(range.note).toBe("This section reads at most 30 days at a time.");
  });

  it("keeps the picked stop as the query stop and ends the data at now", () => {
    const range = countedRange(
      pick("2026-10-05", "2026-11-05"),
      limits.savings,
      NOW
    );
    expect(range.params).toEqual({
      startTime: "2026-10-05T00:00:00.000",
      stopTime: "2026-11-05T00:00:00.000",
    });
    expect(range.end).toBe(NOW);
    expect(range.note).toBeUndefined();
    expect(rangeText(range)).toBe("2026-10-05 to 2026-11-04");
  });

  it("starts ranks and stability on the first day of complete data", () => {
    expect(limits.ranks.validFrom).toBe(day0(RANKS_DATA_FROM));
    expect(limits.ranks.validReason).toBe(
      "TD's rankings are kept from 2026-08-07, for 2 years."
    );
    expect(limits.stability.validFrom).toBe(day0(STABILITY_DATA_FROM));
    expect(limits.stability.validReason).toBe(
      "Run-to-run data is complete from 2026-10-20 and kept for a year."
    );
    const range = countedRange(
      pick("2026-10-05", "2026-11-05"),
      limits.stability,
      NOW
    );
    expect(range.params?.startTime).toBe("2026-10-20T00:00:00.000");
    expect(range.note).toBe(limits.stability.validReason);
  });

  it("counts retention from whole UTC days once it passes the data start", () => {
    const stability = sectionLimits(ms("2027-12-01T12:00:00.000")).stability;
    expect(stability.validFrom).toBe(day0("2026-12-16"));
    expect(
      sectionLimits(ms("2027-12-01T23:59:59.000")).stability.validFrom
    ).toBe(stability.validFrom);
    expect(sectionLimits(ms("2028-09-01T12:00:00.000")).ranks.validFrom).toBe(
      day0("2026-09-03")
    );
  });

  it("keeps the chunked sections free of a clamp, so long picks reach the grid", () => {
    expect("clampDays" in limits.breakages).toBe(false);
    expect("clampDays" in limits.ranks).toBe(false);
    expect("clampDays" in limits.stability).toBe(false);
  });

  it("clamps a future stop back from the end of today, as the SQL does", () => {
    const future = pick("2026-08-01", "2027-01-15");
    const ranks = countedRange(future, limits.ranks, NOW);
    expect(ranks.params).toEqual({
      startTime: "2026-08-07T00:00:00.000",
      stopTime: "2027-01-15T00:00:00.000",
    });
    expect(ranks.note).toBe(limits.ranks.validReason);
    const clamped = countedRange(future, { clampDays: 30 }, NOW);
    expect(clamped.empty).toBe(false);
    expect(clamped.params).toEqual({
      startTime: "2026-10-06T00:00:00.000",
      stopTime: "2027-01-15T00:00:00.000",
    });
    expect(clamped.end).toBe(NOW);
    expect(rangeText(clamped)).toBe("2026-10-06 to 2026-11-04");
    expect(clamped.note).toBe("This section reads at most 30 days at a time.");
    const later = countedRange(
      future,
      { clampDays: 30 },
      ms("2026-11-04T23:59:59.000")
    );
    expect(later.params).toEqual(clamped.params);
  });

  it("is empty before the valid-from day, in the future and inverted", () => {
    const before = countedRange(
      pick("2026-05-01", "2026-07-01"),
      limits.breakages,
      NOW
    );
    expect(before.empty).toBe(true);
    expect(before.params).toBeUndefined();
    expect(before.note).toBe(limits.breakages.validReason);
    expect(
      countedRange(pick("2026-11-10", "2026-11-20"), limits.savings, NOW).empty
    ).toBe(true);
    expect(
      countedRange(pick("2026-10-20", "2026-10-10"), limits.savings, NOW).empty
    ).toBe(true);
  });
});

describe("rangeChunks", () => {
  const anchor = day0(JOB_NAMES_VALID_FROM);
  const chunked = (start: string, stop: string, now = NOW) =>
    sectionChunks("breakages", pick(start, stop), now);

  function expectTiling(
    chunks: Chunk[],
    range: { params?: { startTime: string; stopTime: string } },
    cellDays: number
  ) {
    expect(chunks[0].startTime).toBe(range.params?.startTime);
    expect(chunks[chunks.length - 1].stopTime).toBe(range.params?.stopTime);
    chunks.forEach((chunk, i) => {
      const from = ms(chunk.startTime);
      const to = ms(chunk.stopTime);
      expect(to).toBeGreaterThan(from);
      expect(to - from).toBeLessThanOrEqual(cellDays * DAY_MS);
      if (i > 0) {
        expect(chunk.startTime).toBe(chunks[i - 1].stopTime);
        expect((from - anchor) % (cellDays * DAY_MS)).toBe(0);
      }
    });
    return chunks;
  }

  it("tiles the range on a 90-day grid anchored at the valid-from day", () => {
    const later = ms("2027-12-01T00:00:00.000");
    const first = chunked("2026-06-01", "2027-03-28", later);
    expect(
      expectTiling(first.chunks, first.range, 90).map((c) => c.label)
    ).toEqual([
      "2026-07-13 to 2026-10-10",
      "2026-10-11 to 2027-01-08",
      "2027-01-09 to 2027-03-27",
    ]);
    const second = chunked("2026-10-01", "2027-06-15", later);
    expect(expectTiling(second.chunks, second.range, 90)).toHaveLength(4);
  });

  it("tiles stability on a 49-day grid whose cells start on Mondays", () => {
    const later = ms("2027-04-01T12:00:00.000");
    const { chunks, range } = sectionChunks(
      "stability",
      pick("2026-10-01", "2027-03-01"),
      later
    );
    expect(expectTiling(chunks, range, 49).map((c) => c.label)).toEqual([
      "2026-10-20 to 2026-12-06",
      "2026-12-07 to 2027-01-24",
      "2027-01-25 to 2027-02-28",
    ]);
    for (const chunk of chunks.slice(1)) {
      expect(new Date(ms(chunk.startTime)).getUTCDay()).toBe(1);
    }
    expect(range.note).toBe(sectionLimits(later).stability.validReason);
  });

  it("starts mid-cell and skips cells that start after now", () => {
    const { chunks } = chunked("2026-10-01", "2026-11-05");
    expect(chunks).toEqual([
      {
        startTime: "2026-10-01T00:00:00.000",
        stopTime: "2026-10-11T00:00:00.000",
        label: "2026-10-01 to 2026-10-10",
      },
      {
        startTime: "2026-10-11T00:00:00.000",
        stopTime: "2026-11-05T00:00:00.000",
        label: "2026-10-11 to 2026-11-04",
      },
    ]);
    const now = ms("2027-01-08T12:00:00.000");
    const late = chunked("2026-12-01", "2027-01-20", now).chunks;
    expect(late.map((c) => c.stopTime)).toEqual(["2027-01-09T00:00:00.000"]);
  });

  it("has no chunks for an empty, inverted or future range", () => {
    expect(chunked("2026-05-01", "2026-07-01").chunks).toEqual([]);
    expect(chunked("2026-10-20", "2026-10-10").chunks).toEqual([]);
    expect(chunked("2026-11-10", "2026-12-10").chunks).toEqual([]);
  });

  it("keeps the newest MAX_CHUNKS cells and narrows the range by its cell size", () => {
    const later = ms("2030-01-01T00:00:00.000");
    for (const cellDays of [90, 49]) {
      const { chunks, range } = rangeChunks(
        countedRange(pick("2026-07-13", "2029-09-01"), {}, later),
        cellDays,
        later
      );
      expect(chunks).toHaveLength(MAX_CHUNKS);
      expect(range.params?.startTime).toBe(chunks[0].startTime);
      expect(range.start).toBe(ms(chunks[0].startTime));
      expect((range.start - anchor) % (cellDays * DAY_MS)).toBe(0);
      expect(range.note).toBe(
        `This section reads at most ${MAX_CHUNKS * cellDays} days at a time.`
      );
    }
  });

  it("never narrows a year of stability on any day of a 49-day cycle", () => {
    const first = day0("2028-01-03");
    for (let d = 0; d < 49; d++) {
      const today = first + d * DAY_MS;
      const now = today + DAY_MS / 2;
      const picked = {
        startTime: new Date(today - 365 * DAY_MS).toISOString().slice(0, -1),
        stopTime: new Date(today + DAY_MS).toISOString().slice(0, -1),
      };
      const whole = rangeChunks(
        countedRange(picked, {}, now),
        CLAMP_DAYS.stability,
        now
      );
      expect(whole.chunks.length).toBeLessThanOrEqual(MAX_CHUNKS);
      expect(whole.range.note).toBeUndefined();
      const kept = sectionChunks("stability", picked, now);
      expect(kept.range.note).toBe(sectionLimits(now).stability.validReason);
      expect(kept.chunks[0].startTime).toBe(kept.range.params?.startTime);
    }
  });

  it("splits a long ranks pick into chunks from the first day of rankings", () => {
    const december = ms("2026-12-15T12:00:00.000");
    const past = sectionChunks(
      "ranks",
      pick("2026-08-01", "2026-09-15"),
      december
    );
    expect(past.range.params?.startTime).toBe("2026-08-07T00:00:00.000");
    expect(past.range.note).toBe(sectionLimits(december).ranks.validReason);
    expect(past.chunks.map((c) => c.label)).toEqual([
      "2026-08-07 to 2026-09-14",
    ]);
    const june = ms("2027-06-15T12:00:00.000");
    const long = sectionChunks("ranks", pick("2026-08-07", "2027-06-01"), june);
    expect(long.range.note).toBeUndefined();
    expect(long.chunks.map((c) => c.label)).toEqual([
      "2026-08-07 to 2026-10-10",
      "2026-10-11 to 2027-01-08",
      "2027-01-09 to 2027-04-08",
      "2027-04-09 to 2027-05-31",
    ]);
  });
});

const CHUNKS: Chunk[] = [
  { startTime: "a", stopTime: "b", label: "2026-09-09 to 2026-12-07" },
  { startTime: "b", stopTime: "c", label: "2026-12-08 to 2027-01-01" },
];
const answer = <T>(rows: T[]): TdQueryState<T> => ({ loading: false, rows });

describe("mergeChunks", () => {
  const event = (sha: string) =>
    breakageTotal({ grain: "event", landing_sha: sha });

  it("sums the breakage counts it reads and keeps the events", () => {
    const merged = mergeChunks(
      "td_x",
      CHUNKS,
      [
        answer([
          breakageTotal({
            events: "3",
            false_green: "1",
            signal_on_pr: "1",
            landed_prs: "100",
            unknown: "1",
          }),
          event("a1"),
        ]),
        answer([
          event("b1"),
          breakageTotal({ events: 2, false_green: "2", passed_on_pr: "0" }),
        ]),
      ],
      CHUNKED_SECTIONS.breakages
    );
    expect(merged.error).toBeUndefined();
    expect(merged.total).toEqual({
      events: 5,
      false_green: 3,
      signal_on_pr: 1,
      passed_on_pr: 0,
    });
    expect(merged.rows.map((r) => r.landing_sha)).toEqual(["a1", "b1"]);
  });

  it("sums the rank counts it reads and keeps the landings", () => {
    const landing = (sha: string) => rank({ grain: "landing", sha });
    const merged = mergeChunks(
      "td_x",
      CHUNKS,
      [
        answer([
          rank({ landings: "24", inside_cut: "9", failures: 160 }),
          rank({ grain: "hist", bucket_pct: 3, landings: 24 }),
          landing("a1"),
        ]),
        answer([
          landing("b1"),
          rank({ landings: 13, inside_cut: "10", median_pct: 4.2 }),
        ]),
      ],
      CHUNKED_SECTIONS.ranks
    );
    expect(merged.total).toEqual({ landings: 37, inside_cut: 19 });
    expect(merged.rows.map((r) => r.sha)).toEqual(["a1", "b1"]);
  });

  it("sums the pair counts it reads and keeps day, week and hist rows", () => {
    const merged = mergeChunks(
      "td_x",
      CHUNKS,
      [
        answer([
          churn({ grain: "day", bucket: "2026-10-20", pairs: 4 }),
          churn({ grain: "week", bucket: "2026-10-19", pairs: 4 }),
          histRow(4.5, 1),
          churn({ pairs: "24105", identical_pairs: "15507", prs: 900 }),
        ]),
        answer([
          churn({ pairs: 27890, identical_pairs: "18981", prs: 1000 }),
          histRow(4.5, "2"),
        ]),
      ],
      CHUNKED_SECTIONS.stability
    );
    expect(merged.total).toEqual({ pairs: 51995, identical_pairs: 34488 });
    expect(merged.rows.map((r) => r.grain)).toEqual([
      "day",
      "week",
      "hist",
      "hist",
    ]);
  });

  it("fails on a chunk without exactly one total row, naming its dates", () => {
    const missing = mergeChunks(
      "td_x",
      CHUNKS,
      [answer([churn({})]), answer([histRow(1, 1)])],
      CHUNKED_SECTIONS.stability
    );
    expect(missing.error).toBe(
      "td_x (2026-12-08 to 2027-01-01): 0 total rows, expected 1"
    );
    expect(missing.tileError).toBe(missing.error);
    expect(missing.total).toBeUndefined();
    const duplicate = mergeChunks(
      "td_x",
      CHUNKS,
      [answer([rank({}), rank({})]), answer([rank({})])],
      CHUNKED_SECTIONS.ranks
    );
    expect(duplicate.error).toBe(
      "td_x (2026-09-09 to 2026-12-07): 2 total rows, expected 1"
    );
  });

  it("fails on a failed chunk even while another loads", () => {
    const merged = mergeChunks(
      "td_x",
      CHUNKS,
      [HELD_SLOT, { loading: false, error: "td_x: boom", rows: [] }],
      CHUNKED_SECTIONS.breakages
    );
    expect(merged.error).toBe(
      "td_x: boom (2026-12-08 to 2027-01-01). Reload the page to retry."
    );
    expect(merged.tileError).toBe(merged.error);
  });

  it("fails on a count that is null or not a number, naming it", () => {
    for (const bad of [null, "", "n/a"]) {
      const merged = mergeChunks(
        "td_x",
        CHUNKS,
        [
          answer([churn({ pairs: 4, identical_pairs: 2 })]),
          answer([churn({ pairs: 4, identical_pairs: bad })]),
        ],
        CHUNKED_SECTIONS.stability
      );
      expect(merged.error).toBe(
        "td_x (2026-12-08 to 2027-01-01): identical_pairs is not a number"
      );
      expect(merged.total).toBeUndefined();
    }
  });

  it("waits for a loading or held chunk and needs a slot per chunk", () => {
    for (const waiting of [{ loading: true, rows: [] }, HELD_SLOT]) {
      expect(
        mergeChunks(
          "td_x",
          CHUNKS,
          [answer([churn({})]), waiting],
          CHUNKED_SECTIONS.stability
        )
      ).toEqual({ loading: true, rows: [] });
    }
    expect(
      mergeChunks(
        "td_x",
        CHUNKS,
        [answer([churn({})])],
        CHUNKED_SECTIONS.stability
      ).error
    ).toBe("td_x: more chunks than query slots");
    const noStates: TdQueryState<ChurnRow>[] = [];
    const none = mergeChunks("td_x", [], noStates, CHUNKED_SECTIONS.stability);
    expect(none.total).toBeUndefined();
    expect(none.loading).toBe(false);
  });
});

describe("chunk slots", () => {
  const loading = { loading: true, rows: [] };
  const failed = { loading: false, error: "td_x: boom", rows: [] };
  const done = answer([]);

  it("start in order with at most two in flight, and none after a failure", () => {
    expect(slotStarts([])).toBe(true);
    expect(slotStarts([loading])).toBe(true);
    expect(slotStarts([done, loading])).toBe(true);
    expect(slotStarts([loading, loading])).toBe(false);
    expect(slotStarts([loading, done])).toBe(false);
    expect(slotStarts([done, HELD_SLOT])).toBe(true);
    expect(slotStarts([done, done, loading, HELD_SLOT])).toBe(false);
    expect(slotStarts([failed])).toBe(false);
    expect(slotStarts([done, failed])).toBe(false);
    expect(slotStarts([failed, done, done])).toBe(false);
  });

  const chunks: Chunk[] = ["c0", "c1", "c2", "c3"].map((start, i) => ({
    startTime: start,
    stopTime: `c${i + 1}`,
    label: `chunk ${i}`,
  }));
  const total = (pairs: number) => [churn({ pairs })];

  function render(answers: Record<string, MockAnswer>) {
    mockApi.calls = [];
    mockApi.respond = (_name, startTime) => answers[startTime] ?? {};
    let states: TdQueryState<ChurnRow>[] = [];
    function Probe() {
      states = useChunkedTdQuery<ChurnRow>("td_x", chunks);
      return null;
    }
    renderToStaticMarkup(createElement(Probe));
    return { states, fetched: mockApi.calls.map((call) => call.startTime) };
  }

  it("holds a slot back as loading until its turn", () => {
    const { states, fetched } = render({});
    expect(states).toHaveLength(MAX_CHUNKS);
    expect(fetched).toEqual(["c0", "c1"]);
    expect(states.slice(2, 4)).toEqual([HELD_SLOT, HELD_SLOT]);
    expect(states.slice(4)).toEqual(
      new Array(MAX_CHUNKS - 4).fill({ loading: false, rows: [] })
    );
    expect(
      mergeChunks("td_x", chunks, states, CHUNKED_SECTIONS.stability)
    ).toEqual({ loading: true, rows: [] });
  });

  it("starts the next slot once every slot before the one in flight answered", () => {
    expect(render({ c0: { data: total(1) } }).fetched).toEqual([
      "c0",
      "c1",
      "c2",
    ]);
    expect(render({ c1: { data: total(1) } }).fetched).toEqual(["c0", "c1"]);
    const all = render({
      c0: { data: total(1) },
      c1: { data: total(2) },
      c2: { data: total(3) },
      c3: { data: total(4) },
    });
    expect(all.fetched).toEqual(["c0", "c1", "c2", "c3"]);
    expect(
      mergeChunks("td_x", chunks, all.states, CHUNKED_SECTIONS.stability).total
    ).toEqual({ pairs: 10, identical_pairs: 0 });
  });

  it("starts nothing after a failure and fails the section", () => {
    const { states, fetched } = render({
      c0: { data: total(1) },
      c1: { error: new Error("boom") },
    });
    expect(fetched).toEqual(["c0", "c1"]);
    expect(states.slice(2, 4)).toEqual([HELD_SLOT, HELD_SLOT]);
    expect(
      mergeChunks("td_x", chunks, states, CHUNKED_SECTIONS.stability).error
    ).toBe("td_x: boom (chunk 1). Reload the page to retry.");
    expect(render({ c0: { error: new Error("boom") } }).fetched).toEqual([
      "c0",
    ]);
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

  it("charts shares as gaps without pairs, from the day rows only", () => {
    const rows = [
      churn({
        grain: "day",
        bucket: "2026-10-01",
        pairs: "4",
        identical_pairs: "3",
        changed_median_pct: "6.5",
      }),
      churn({ grain: "day", bucket: "2026-10-02", pairs: "0" }),
      histRow(0.2, 40),
      churn({ pairs: "4", identical_pairs: "3", changed_median_pct: 9 }),
    ];
    const w = window("2026-10-01T00:00:00.000", "2026-10-03T00:00:00.000");
    expect(buildPlot(TD_CHARTS.samePicks, rows, "day", w).values).toEqual([
      [75, null],
    ]);
    expect(buildPlot(TD_CHARTS.typicalChange, rows, "day", w).values).toEqual([
      [6.5, null],
    ]);
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
        {
          name: "Not yet counted",
          xAxis: day0("2026-10-03") - DAY_MS / 2,
          itemStyle: { color: "rgba(128, 128, 128, 0.15)" },
        },
        { xAxis: day0("2026-10-03") + DAY_MS / 2 },
      ],
    ]);
    expect(series[1].markArea).toBeUndefined();
    const partial = tooltipText(TD_CHARTS.recall, plot, 0);
    expect(partial).toContain("Partial bucket");
    expect(partial).toContain("False greens: 1");
    expect(partial).toContain("Total: 1");
    expect(tooltipText(TD_CHARTS.recall, plot, 2)).toContain(PENDING_NOTE);
    const options = plotOptions(TD_CHARTS.recall, plot);
    expect(options.useUTC).toBe(true);
    expect(options.xAxis).toEqual({
      min: day0("2026-10-01") - DAY_MS / 2,
      max: day0("2026-10-03") + DAY_MS / 2,
    });
  });

  it("charts breakages before the new-test check as an upper bound", () => {
    const closed = (landed: string) =>
      breakageTotal({
        grain: "event",
        landed_at: landed,
        outcome: "false_green",
        window_closed: 1,
      });
    const rows = [
      closed("2026-09-10 10:00:00.000"),
      closed("2026-09-13 10:00:00.000"),
    ];
    const plot = buildPlot(TD_CHARTS.falseGreens, rows, "day", {
      ...window("2026-09-10T00:00:00.000", "2026-09-14T00:00:00.000"),
      upperBoundBefore: day0(NEW_TEST_CHECK_FROM),
    });
    expect(plot.upperBound).toEqual([true, true, false, false]);
    expect(plot.values[0]).toEqual([1, 0, 0, 1]);
    const areas = plotSeries(TD_CHARTS.falseGreens, plot)[0].markArea?.data;
    expect(areas).toEqual([
      [
        {
          name: "Upper bound",
          xAxis: day0("2026-09-10") - DAY_MS / 2,
          itemStyle: { color: "rgba(237, 108, 2, 0.12)" },
        },
        { xAxis: day0("2026-09-11") + DAY_MS / 2 },
      ],
    ]);
    expect(tooltipText(TD_CHARTS.falseGreens, plot, 0)).toContain(
      `Upper bound: before ${NEW_TEST_CHECK_FROM}`
    );
    expect(tooltipText(TD_CHARTS.falseGreens, plot, 2)).not.toContain(
      "Upper bound"
    );
    const weekly = buildPlot(TD_CHARTS.falseGreens, rows, "week", {
      ...window("2026-09-10T00:00:00.000", "2026-09-21T00:00:00.000"),
      upperBoundBefore: day0(NEW_TEST_CHECK_FROM),
    });
    expect(weekly.upperBound).toEqual([true, false]);
  });

  it("puts event rows outside the axis in the nearest end bucket", () => {
    const landing = (landed: string, inside: number) =>
      rank({
        grain: "landing",
        landings: 1,
        landed_at: landed,
        inside_cut: inside,
      });
    const rows = [
      landing("2026-09-22 23:24:00.000", 1),
      landing("2026-09-23 08:00:00.000", 0),
      landing("2026-09-25 00:00:00.000", 1),
      landing("", 1),
    ];
    const plot = buildPlot(
      TD_CHARTS.caught,
      rows,
      "day",
      window("2026-09-23T00:00:00.000", "2026-09-25T00:00:00.000")
    );
    expect(plot.buckets.map((b) => b.key)).toEqual([
      "2026-09-23",
      "2026-09-24",
    ]);
    expect(plot.values).toEqual([
      [1, 1],
      [1, 0],
    ]);
  });

  it("charts the tile's median saving and labels each axis by its values", () => {
    const rows = [
      {
        grain: "day",
        bucket: "2026-10-01",
        pushes: "10",
        saved_median_min: "12.5",
        actual_ttg_median_min: "80",
        est_ttg_median_min: "95",
      },
      { grain: "day", bucket: "2026-10-02", pushes: "0", saved_median_min: 0 },
    ];
    const plot = buildPlot(
      TD_CHARTS.ttgSaved,
      rows,
      "day",
      window("2026-10-01T00:00:00.000", "2026-10-03T00:00:00.000")
    );
    expect(plot.values).toEqual([
      [12.5, null],
      [80, null],
      [95, null],
    ]);
    expect(TD_CHARTS.typicalChange.axisLabel).toBe("% of test files");
    expect(TD_CHARTS.samePicks.axisLabel).toBeUndefined();
  });
});

const quoted = (values: string[]) => values.map((v) => `'${v}'`);
const WORKFLOWS = quoted(TD_SCOPE.tdWorkflows).join(", ");
const PREFIXES = quoted(TD_SCOPE.tdWorkflowPrefixes);
const MARKERS = quoted(TD_SCOPE.noTdBuildMarkers).join(", ");
const WINDOW = { startTime: "DateTime64(3)", stopTime: "DateTime64(3)" };
const JOB_NAMES_FLOOR = `toDateTime64('${JOB_NAMES_VALID_FROM} 00:00:00', 3)`;

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
    grains: ["day", "week", "total"],
    literals: [
      WORKFLOWS,
      ...PREFIXES,
      MARKERS,
      `>= ${MIN_MAIN_RUNS} AS matched`,
      JOB_NAMES_FLOOR,
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
      JOB_NAMES_FLOOR,
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
    horizonDays: CLAMP_DAYS.breakages,
    grains: ["event", "total"],
    literals: [
      ...PREFIXES,
      MARKERS,
      `toIntervalDay(${REVERT_WINDOW_DAYS})`,
      `toIntervalDay(${NEW_TEST_DAYS})`,
      JOB_NAMES_FLOOR,
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
    grains: ["total", "landing"],
    literals: [WORKFLOWS, ...PREFIXES, MARKERS, `intDiv(${TD_CUT_PCT} * `],
  },
  [TD_QUERIES.churn]: {
    columns: [
      "grain",
      "bucket",
      "bucket_pct",
      "pairs",
      "identical_pairs",
      "changed_median_pct",
      "prs",
    ],
    params: WINDOW,
    horizonDays: CLAMP_DAYS.stability,
    grains: ["day", "week", "hist", "total"],
    literals: [
      "workflow_name = 'pull'",
      MARKERS,
      `toIntervalDay(${STABILITY_LOOK_BACK_DAYS}) AS look_back`,
      "window_start - look_back AS sets_start",
      "earlier_created >= later_created - look_back",
    ],
  },
};

describe("clamp widths", () => {
  it("match the SQL clamps the contracts check", () => {
    expect(CLAMP_DAYS).toEqual({
      savings: 365,
      pushWait: 365,
      breakages: 90,
      ranks: 90,
      stability: 49,
    });
  });

  it("make stability chunks whole weeks on a Monday grid", () => {
    expect(CLAMP_DAYS.stability % 7).toBe(0);
    expect(new Date(day0(JOB_NAMES_VALID_FROM)).getUTCDay()).toBe(1);
    expect(MAX_CHUNKS * CLAMP_DAYS.stability).toBeGreaterThanOrEqual(
      366 + CLAMP_DAYS.stability - 1
    );
  });
});

describe("data starts", () => {
  it("start ranks on the first whole day of TD's rankings", () => {
    expect(RANKS_DATA_FROM).toBe("2026-08-07");
    expect(day0(RANKS_DATA_FROM)).toBe(
      Math.ceil(ms("2026-08-06T22:28:00.000") / DAY_MS) * DAY_MS
    );
  });

  it("start stability once a pair's look-back lies inside test_run_summary", () => {
    expect(STABILITY_DATA_FROM).toBe("2026-10-20");
    const firstWholeDay =
      Math.ceil(ms("2026-10-05T22:37:00.000") / DAY_MS) * DAY_MS;
    expect(day0(STABILITY_DATA_FROM)).toBe(
      firstWholeDay + STABILITY_LOOK_BACK_DAYS * DAY_MS
    );
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

describe("td_selection_churn look-back", () => {
  it("is one interval, used for the sets read and for the gap rule", () => {
    const sql = fs.readFileSync(
      path.join(queriesDir, TD_QUERIES.churn, "query.sql"),
      "utf8"
    );
    expect(sql.match(/\blook_back\b/g)).toHaveLength(3);
    expect(sql).not.toMatch(
      new RegExp(
        `INTERVAL ${STABILITY_LOOK_BACK_DAYS} DAY|toIntervalDay\\(${STABILITY_LOOK_BACK_DAYS}\\)(?! AS look_back)`
      )
    );
  });
});

function sqlClampDays(queryName: string): number {
  const sql = fs.readFileSync(
    path.join(queriesDir, queryName, "query.sql"),
    "utf8"
  );
  const clamp = sql.match(
    /window_end - (?:INTERVAL (\d+) DAY|toIntervalDay\((\d+)\))/
  );
  return Number(clamp?.[1] ?? clamp?.[2]);
}

describe("chunked sections", () => {
  it("cut each section into cells as wide as its query's SQL clamp", () => {
    for (const [section, spec] of Object.entries(CHUNKED_SECTIONS)) {
      expect([section, spec.cellDays]).toEqual([
        section,
        sqlClampDays(spec.query),
      ]);
    }
  });
});

const CLOSED_CHARTS: TdChartsState = {
  open: new Set(),
  onToggle: () => {},
  granularity: "day",
};
const TOTALS: Record<string, unknown[]> = {
  [TD_QUERIES.breakages]: [breakageTotal({})],
  [TD_QUERIES.ranks]: [rank({})],
  [TD_QUERIES.churn]: [churn({})],
};
const SECTIONS: [
  ChunkedSection,
  ComponentType<{ params: TdParams; charts: TdChartsState }>,
  string
][] = [
  ["breakages", BreakagesSection, "td_trunk_breakages"],
  ["ranks", RankingSection, "td_failure_ranks"],
  ["stability", StabilitySection, "td_selection_churn"],
];

describe("section rendering", () => {
  afterEach(() => {
    jest.useRealTimers();
    mockApi.respond = () => ({});
  });

  function renderSection(
    Section: ComponentType<{ params: TdParams; charts: TdChartsState }>,
    params: TdParams,
    now: number,
    respond: (_name: string, _startTime: string) => MockAnswer
  ) {
    jest.useFakeTimers({ now });
    mockApi.calls = [];
    mockApi.respond = respond;
    const html = renderToStaticMarkup(
      createElement(Section, { params, charts: CLOSED_CHARTS })
    );
    const texts = html
      .replace(/<style[^>]*>[^<]*<\/style>/g, "")
      .replace(/<[^>]+>/g, "\n")
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, "&")
      .split("\n")
      .map((text) => text.trim())
      .filter((text) => text !== "");
    return { texts, calls: [...mockApi.calls] };
  }

  // The value and the line under it on the tile with this label.
  const face = (texts: string[], label: string) => {
    const at = texts.indexOf(label);
    expect(at).toBeGreaterThanOrEqual(0);
    return texts.slice(at + 1, at + 3);
  };
  const answered = (name: string) => ({ data: TOTALS[name] });

  it.each(SECTIONS)(
    "%s fetches only its query, in cells of that query's clamp, from its own first day",
    (section, Section, query) => {
      const now = ms("2027-12-01T12:00:00.000");
      const { calls } = renderSection(
        Section,
        pick("2026-07-13", "2027-12-02"),
        now,
        answered
      );
      const clamp = sqlClampDays(query);
      const anchor = day0(JOB_NAMES_VALID_FROM);
      expect(calls.length).toBeGreaterThan(1);
      expect(calls[0].startTime).toBe(
        new Date(sectionLimits(now)[section].validFrom)
          .toISOString()
          .slice(0, -1)
      );
      expect(calls[calls.length - 1].stopTime).toBe("2027-12-02T00:00:00.000");
      calls.forEach((call, i) => {
        expect(call.name).toBe(query);
        expect(ms(call.stopTime) - ms(call.startTime)).toBeLessThanOrEqual(
          clamp * DAY_MS
        );
        if (i > 0) {
          expect(call.startTime).toBe(calls[i - 1].stopTime);
          expect((ms(call.startTime) - anchor) % (clamp * DAY_MS)).toBe(0);
        }
      });
    }
  );

  it("shows a real zero for breakage counts once every chunk answered", () => {
    const { texts } = renderSection(
      BreakagesSection,
      pick("2026-10-01", "2026-11-05"),
      NOW,
      answered
    );
    expect(face(texts, "False greens")[0]).toBe("0");
    expect(face(texts, "Reverted landings traced")[0]).toBe("0");
    expect(face(texts, "Breakage recall")).toEqual(["-", NOTHING_TO_MEASURE]);
    expect(texts).not.toContain(NO_DATA_IN_WINDOW);
  });

  it("keeps the pending sentence while every landing may still be reverted", () => {
    const { texts } = renderSection(
      BreakagesSection,
      pick("2026-11-01", "2026-11-05"),
      NOW,
      answered
    );
    for (const label of [
      "False greens",
      "Breakage recall",
      "Reverted landings traced",
    ]) {
      expect(face(texts, label)).toEqual(["-", PENDING_NOTE]);
    }
  });

  it("bounds false greens and recall before the new-test check", () => {
    const { texts } = renderSection(
      BreakagesSection,
      pick("2026-09-01", "2026-10-01"),
      NOW,
      answered
    );
    expect(
      texts.some((text) =>
        text.endsWith(
          "so false greens there are an upper bound, and recall a lower bound."
        )
      )
    ).toBe(true);
  });

  it("has nothing to measure for the caught share without landings", () => {
    const { texts } = renderSection(
      RankingSection,
      pick("2026-10-01", "2026-11-05"),
      NOW,
      answered
    );
    expect(face(texts, "Trunk breakages TD would have caught")).toEqual([
      "-",
      NOTHING_TO_MEASURE,
    ]);
  });

  it("names a failed chunk and asks for a reload", () => {
    const { texts } = renderSection(
      BreakagesSection,
      pick("2026-10-01", "2026-11-05"),
      NOW,
      (name, startTime) =>
        startTime === "2026-10-01T00:00:00.000"
          ? { error: new Error("boom") }
          : answered(name)
    );
    expect(face(texts, "False greens")[0]).toBe(
      "td_trunk_breakages: boom (2026-10-01 to 2026-10-10). Reload the page to retry."
    );
  });
});
