import { GET } from "app/api/tests/cost/trend/route";
import { buildOpenApiDocument } from "lib/api/openapi";
import type { RawQuery } from "lib/api/parameters";
import { ErrorResponseSchema } from "lib/api/schema";
import { costTrendQueryParameters } from "lib/api/tests/cost/parameters";
import {
  trendDailyQuery,
  trendPushesQuery,
  trendQuery,
} from "lib/api/tests/cost/query";
import * as trend from "lib/api/tests/cost/trend";
import {
  compactTrend,
  getCostTrend,
  periodStart,
  trendWindow,
} from "lib/api/tests/cost/trend";
import { CostTrendSchema } from "lib/api/tests/cost/types";
import * as clickhouse from "lib/clickhouse";
import { callRoute } from "test/api/routes";
import TREND_JSON from "test/tests/cost/trend.json";

// The routes are behind the GitHub gate, which has its own tests (auth.test.ts);
// here the handlers answer as themselves.
jest.mock("lib/api/auth", () => ({
  requireGithubWriteAccess: (handler: unknown) => handler,
}));

// The example answer beside the cost page's tests.
const ANSWER = CostTrendSchema.parse(TREND_JSON);
// A Thursday morning, UTC.
const NOW = new Date("2026-11-05T06:00:00Z");

describe("the trend's periods", () => {
  test("a day, its Monday, or the first of its month", () => {
    const day = Date.parse("2026-11-01T00:00:00Z"); // a Sunday
    const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    expect(ymd(periodStart("day", day))).toBe("2026-11-01");
    expect(ymd(periodStart("week", day))).toBe("2026-10-26");
    expect(ymd(periodStart("week", Date.parse("2026-10-26T00:00:00Z")))).toBe(
      "2026-10-26"
    );
    expect(ymd(periodStart("month", day))).toBe("2026-11-01");
  });

  test("42 days, 26 weeks or 13 months ending with yesterday's, today left out; the daily totals from January 1", () => {
    const day = trendWindow("day", NOW);
    expect(day.periods).toHaveLength(42);
    expect([day.start, day.periods[41], day.end]).toEqual([
      "2026-09-24",
      "2026-11-04",
      "2026-11-05",
    ]);
    expect(day.params).toEqual({
      start: "2026-09-24 00:00:00.000",
      end: "2026-11-05 00:00:00.000",
    });
    expect(day.dailyParams.start).toBe("2026-01-01 00:00:00.000");
    const week = trendWindow("week", NOW);
    expect(week.periods).toHaveLength(26);
    // Yesterday was Wednesday Nov 4: its week began Monday Nov 2.
    expect([week.start, week.periods[25]]).toEqual([
      "2026-05-11",
      "2026-11-02",
    ]);
    const month = trendWindow("month", NOW);
    expect(month.periods).toHaveLength(13);
    expect([month.start, month.periods[12]]).toEqual([
      "2025-11-01",
      "2026-11-01",
    ]);
    // A year and a month back is before January 1: the daily totals start
    // there too.
    expect(month.dailyStart).toBe("2025-11-01");
  });

  test("on January 1, the periods end on December 31 and the year to date is the year just ended", () => {
    const w = trendWindow("day", new Date("2027-01-01T05:00:00Z"));
    expect([w.periods[41], w.end, w.dailyStart]).toEqual([
      "2026-12-31",
      "2027-01-01",
      "2026-01-01",
    ]);
  });
});

describe("compactTrend", () => {
  const periods = ["2026-11-02", "2026-11-03"];
  const row = (
    period: string,
    owner: string,
    label: string,
    h: number,
    main = 0
  ) => ({
    period,
    owner,
    label,
    runner_hours: h,
    main_runner_hours: main,
  });
  const day = (d: string, label: string, h: number, main = 0) => ({
    day_utc: d,
    label,
    runner_hours: h,
    main_runner_hours: main,
  });

  test("names owners and labels once, most runner-hours first; cells as sorted index tuples with their push:main hours, empty ones and periods outside the window left out; each day's pushes to main", () => {
    expect(
      compactTrend(
        periods,
        [
          row("2026-11-03", "nn", "linux.2xlarge", 1),
          row("2026-11-02", "inductor", "linux.g6", 5, 2),
          row("2026-11-02", "nn", "linux.g6", 2, 0.5),
          row("2026-11-03", "inductor", "linux.2xlarge", 0),
          row("2026-10-26", "inductor", "linux.g6", 9),
        ],
        [
          day("2026-11-03", "linux.2xlarge", 1),
          day("2026-11-02", "linux.g6", 7, 2.5),
          // Before the periods: its label is named after theirs.
          day("2026-03-01", "macos-m1-stable", 50, 10),
        ],
        [
          { day_utc: "2026-11-02", pushes: "48" },
          { day_utc: "2026-03-01", pushes: 20 },
          // A day the rollup does not hold.
          { day_utc: "2026-11-04", pushes: 58 },
        ]
      )
    ).toEqual({
      owners: ["inductor", "nn"],
      labels: ["linux.g6", "linux.2xlarge", "macos-m1-stable"],
      cells: [
        [0, 0, 0, 5, 2],
        [0, 1, 0, 2, 0.5],
        [1, 1, 1, 1, 0],
      ],
      daily: {
        days: ["2026-03-01", "2026-11-02", "2026-11-03"],
        filling: [],
        pushes: [20, 48, 0],
        cells: [
          [0, 2, 50, 10],
          [1, 0, 7, 2.5],
          [2, 1, 1, 0],
        ],
      },
    });
  });

  test("a day the scope ran nothing on is still a day with data; a day computed before its jobs finished is filling", () => {
    const out = compactTrend(
      periods,
      [row("2026-11-02", "inductor", "linux.g6", 5)],
      [
        { ...day("2026-11-02", "linux.g6", 5), filling: 0 },
        // The rows outside the scope, folded into label '' at 0 h.
        { ...day("2026-11-03", "", 0), filling: 1 },
      ],
      []
    );
    expect(out.labels).toEqual(["linux.g6"]);
    expect(out.daily).toEqual({
      days: ["2026-11-02", "2026-11-03"],
      filling: ["2026-11-03"],
      pushes: [0, 0],
      cells: [[0, 0, 5, 0]],
    });
  });

  test("loses no runner-hour: the cells hold the rows', the daily totals the daily rows'", () => {
    const rows = [
      row("2026-11-02", "inductor", "linux.g6", 5.25),
      row("2026-11-02", "unattributed:no_owner", "linux.g6", 0.5),
      row("2026-11-03", "nn", "linux.2xlarge", 3),
    ];
    const daily = [
      day("2026-11-02", "linux.g6", 5.75),
      day("2026-11-03", "linux.2xlarge", 3),
    ];
    const out = compactTrend(periods, rows, daily, []);
    const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    expect(total(out.cells.map((c) => c[3]))).toBe(8.75);
    expect(total(out.daily.cells.map((c) => c[2]))).toBe(8.75);
  });
});

describe("getCostTrend", () => {
  afterEach(() => jest.restoreAllMocks());

  test("asks the cells, the daily totals and the pushes to main over their windows, the first two in the scope, none heavy, and answers its schema", async () => {
    const query = jest
      .spyOn(clickhouse, "queryClickhouse")
      .mockImplementation(async (_sql, _params, id) =>
        id === "tests_cost_trend"
          ? [
              {
                period: "2026-11-02",
                owner: "inductor",
                label: "linux.g6",
                runner_hours: 4,
                main_runner_hours: 1,
              },
            ]
          : id === "tests_cost_trend_daily"
          ? [
              {
                day_utc: "2026-11-02",
                label: "linux.g6",
                runner_hours: 4,
                main_runner_hours: 1,
              },
            ]
          : [{ day_utc: "2026-11-02", pushes: "48" }]
      );
    const answer = await getCostTrend(
      { repo: "pytorch/pytorch", rollup: "week", workflow: ["pull", "trunk"] },
      NOW
    );
    expect(query.mock.calls.map((c) => c[2])).toEqual([
      "tests_cost_trend",
      "tests_cost_trend_daily",
      "tests_cost_trend_pushes",
    ]);
    expect(query.mock.calls[0][0]).toBe(trendQuery("week"));
    expect(query.mock.calls[1][0]).toBe(trendDailyQuery());
    expect(query.mock.calls[2][0]).toBe(trendPushesQuery());
    // Pushes to main are the repository's, whatever the scope.
    expect(query.mock.calls[2][1]).toEqual({
      repo: "pytorch/pytorch",
      start: "2026-01-01 00:00:00.000",
      end: "2026-11-05 00:00:00.000",
    });
    expect(query.mock.calls[0][1]).toEqual({
      repo: "pytorch/pytorch",
      workflows: ["pull", "trunk"],
      start: "2026-05-11 00:00:00.000",
      end: "2026-11-05 00:00:00.000",
    });
    expect(query.mock.calls[1][1]).toMatchObject({
      start: "2026-01-01 00:00:00.000",
      workflows: ["pull", "trunk"],
    });
    // About 0.4 CPU-seconds today and 3 for a year of months, the pushes
    // about a second: not heavy.
    expect(query.mock.calls.map((c) => c[4])).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(CostTrendSchema.safeParse(answer).success).toBe(true);
    expect(answer).toMatchObject({
      rollup: "week",
      workflows: ["pull", "trunk"],
      start: "2026-05-11",
      end: "2026-11-05",
      cells: [[25, 0, 0, 4, 1]],
      daily: { start: "2026-01-01", days: ["2026-11-02"], pushes: [48] },
    });
  });

  test("every workflow when none is asked for", async () => {
    const query = jest
      .spyOn(clickhouse, "queryClickhouse")
      .mockResolvedValue([]);
    const answer = await getCostTrend(
      { repo: "pytorch/pytorch", rollup: "day" },
      NOW
    );
    expect(query.mock.calls[0][1]).toMatchObject({ workflows: [] });
    expect(answer.workflows).toEqual([]);
  });

  test("each rollup's SQL starts its periods as periodStart does, and reads each day's latest computation", () => {
    expect(trendQuery("day")).toContain("toString(day) AS period");
    expect(trendQuery("week")).toContain("toString(toMonday(day)) AS period");
    expect(trendQuery("month")).toContain(
      "toString(toStartOfMonth(day)) AS period"
    );
    for (const sql of [trendQuery("day"), trendDailyQuery()]) {
      expect(sql).toContain("(day, computed_at) IN (");
      expect(sql).toContain("{workflows: Array(String)}");
      expect(sql).not.toContain("OVER (");
    }
    // An alias named day would stand for the column in WHERE.
    expect(trendDailyQuery()).not.toMatch(/AS day\b/);
  });
});

function get(query: RawQuery = { repo: "pytorch/pytorch" }) {
  return callRoute(GET, "/api/tests/cost/trend", query);
}

describe("app/api/tests/cost/trend", () => {
  let getTrend: jest.SpyInstance;

  beforeEach(() => {
    getTrend = jest.spyOn(trend, "getCostTrend").mockResolvedValue(ANSWER);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each([
    {},
    { repo: "pytorch" },
    { repo: "pytorch/pytorch", rollup: "year" },
    { repo: "pytorch/pytorch", rollup: ["day", "week"] },
    { repo: "pytorch/pytorch", workflow: "" },
    { repo: "pytorch/pytorch", workflow: "x".repeat(101) },
    { repo: "pytorch/pytorch", window: "7d" },
    { repo: "pytorch/pytorch", owner: "inductor" },
    // Rates stay in the browser.
    { repo: "pytorch/pytorch", rates: "{}" },
  ])(
    "rejects invalid or unsupported parameters before querying %j",
    async (query) => {
      const res = await get(query);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_parameters");
      expect(ErrorResponseSchema.parse(res.body)).toEqual(res.body);
      expect(getTrend).not.toHaveBeenCalled();
    }
  );

  test("answers days by default for every workflow, cached privately for ten minutes", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(getTrend).toHaveBeenCalledWith({
      repo: "pytorch/pytorch",
      rollup: "day",
    });
    expect(res.body).toEqual(ANSWER);
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=600");
    expect(res.headers.get("Vary")).toBe("Authorization, Cookie");
  });

  test("takes a rollup and the workflows once each, sorted", async () => {
    const res = await get({
      repo: "pytorch/pytorch",
      rollup: "month",
      workflow: ["trunk", "pull", "trunk"],
    });
    expect(res.status).toBe(200);
    expect(getTrend).toHaveBeenCalledWith({
      repo: "pytorch/pytorch",
      rollup: "month",
      workflow: ["pull", "trunk"],
    });
  });

  test("logs query failures and answers 500 without exposing details", async () => {
    getTrend.mockRejectedValue(new Error("private database connection failed"));
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const res = await get();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: "Failed to compute the runner-hours trend",
      code: "internal_error",
    });
    expect(consoleError).toHaveBeenCalled();
  });
});

describe("trend OpenAPI", () => {
  const document = buildOpenApiDocument();
  const operation = (document.paths["/api/tests/cost/trend"] as any).get;
  const schemas = document.components.schemas as Record<string, any>;

  test("documents the repository, a rollup of day, week or month, and repeated workflows", () => {
    expect(operation.operationId).toBe("getTestsCostTrend");
    expect(operation.tags).toEqual(["tests"]);
    expect(operation.parameters).toEqual(costTrendQueryParameters());
    expect(operation.parameters.map((p: any) => p.name)).toEqual([
      "repo",
      "rollup",
      "workflow",
    ]);
    const rollup = operation.parameters.find((p: any) => p.name === "rollup");
    expect(rollup.schema).toMatchObject({
      enum: ["day", "week", "month"],
      default: "day",
    });
  });

  test("answers CostTrend, compact, with no prices; errors for bad parameters and failures, no 429", () => {
    expect(
      operation.responses["200"].content["application/json"].schema
    ).toEqual({ $ref: "#/components/schemas/CostTrend" });
    for (const status of ["400", "500"]) {
      expect(
        operation.responses[status].content["application/json"].schema
      ).toEqual({ $ref: "#/components/schemas/ErrorResponse" });
    }
    expect(operation.responses).not.toHaveProperty("429");
    expect(schemas.CostTrend.properties.cells.description).toMatch(
      /\[period, owner, label, runner_hours, main_runner_hours\]/
    );
    expect(operation.description).toMatch(/The API holds no prices/);
    expect(Object.keys(schemas.CostTrend.properties)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/cost|rate|price|budget/i)])
    );
  });
});
