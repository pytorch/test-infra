import fs from "fs";
import {
  breakageStats,
  ciSaved,
  clampedStart,
  commitUrl,
  dataExpiry,
  hoursText,
  MIN_MAIN_RUNS,
  minutesText,
  NEW_TEST_DAYS,
  num,
  prUrl,
  ratio,
  readTdQuery,
  recallCurve,
  REVERT_WINDOW_DAYS,
  TD_CUT_PCT,
  TD_QUERIES,
  TD_SCOPE,
  totalError,
  totalRow,
  wilsonInterval,
  windowDays,
} from "lib/targetDeterminator";
import type {
  BreakageRow,
  RankRow,
  SavingsRow,
} from "lib/targetDeterminatorRows";
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
      { ...hist(7, 9), grain: "miss" },
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

  it("clamps a query's start to the days before the stop", () => {
    const params = {
      startTime: "2026-01-01T00:00:00.000",
      stopTime: "2026-11-05T00:00:00.000",
    };
    expect(clampedStart(params, 90)).toBe("2026-08-07T00:00:00.000");
    expect(
      clampedStart({ ...params, startTime: "2026-10-01T00:00:00.000" }, 90)
    ).toBe("2026-10-01T00:00:00.000");
  });

  it("says when a window's data has expired, wholly or in part", () => {
    const now = Date.parse("2026-11-04T12:00:00.000Z");
    const recent = {
      startTime: "2026-10-05T00:00:00.000",
      stopTime: "2026-11-05T00:00:00.000",
    };
    expect(dataExpiry(recent, 90, 90, now)).toBeUndefined();
    expect(dataExpiry(recent, 14, 30, now)).toBeUndefined();
    const longAgo = {
      startTime: "2026-05-01T00:00:00.000",
      stopTime: "2026-07-01T00:00:00.000",
    };
    expect(dataExpiry(longAgo, 90, 90, now)?.whole).toBe(true);
    const straddling = {
      startTime: "2026-07-01T00:00:00.000",
      stopTime: "2026-09-01T00:00:00.000",
    };
    expect(dataExpiry(straddling, 90, 90, now)?.whole).toBe(false);
    expect(dataExpiry(straddling, 14, 90, now)).toBeUndefined();
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

  it("measures the window in days", () => {
    expect(
      windowDays("2026-10-01T00:00:00.000", "2026-10-31T00:00:00.000")
    ).toBe(30);
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
    horizonDays: 90,
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
    horizonDays: 90,
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
    horizonDays: 90,
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
    horizonDays: 90,
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
    horizonDays: 14,
    literals: ["workflow_name = 'pull'", MARKERS],
  },
};

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
});
