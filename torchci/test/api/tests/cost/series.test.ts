import { GET } from "app/api/tests/cost/series/route";
import type { RawQuery } from "lib/api/parameters";
import { ErrorResponseSchema } from "lib/api/schema";
import {
  costSeriesUrl,
  decodeTrail,
  SERIES_TOP,
  seriesEcho,
} from "lib/api/tests/cost/contracts";
import { scopeDaysQuery, scopeQuery } from "lib/api/tests/cost/scope";
import { compactSeries, getCostSeries } from "lib/api/tests/cost/series";
import { CostSeriesSchema } from "lib/api/tests/cost/types";
import * as clickhouse from "lib/clickhouse";
import { callRoute } from "test/api/routes";

// The routes are behind the GitHub gate, which has its own tests (auth.test.ts);
// here the handlers answer as themselves.
jest.mock("lib/api/auth", () => ({
  requireGithubWriteAccess: (handler: unknown) => handler,
}));

const RANGE = { from: "2026-11-16", to: "2026-11-18" };
const DAYS = [
  { day_utc: "2026-11-16", filling: 0, pushes: 45 },
  { day_utc: "2026-11-17", filling: 0, pushes: 72 },
  { day_utc: "2026-11-18", filling: 1, pushes: 86 },
];

describe("compactSeries", () => {
  test("owners and machines keep every child; cells in day, child and label order", () => {
    const rows = [
      {
        day_utc: "2026-11-17",
        child: "dynamo",
        label: "x",
        runner_hours: 1,
        main_runner_hours: 0,
      },
      {
        day_utc: "2026-11-16",
        child: "inductor",
        label: "x",
        runner_hours: 2,
        main_runner_hours: 1,
      },
      {
        day_utc: "2026-11-16",
        child: "inductor",
        label: "y",
        runner_hours: 0.5,
        main_runner_hours: 0,
      },
    ];
    expect(compactSeries("o", RANGE, rows, DAYS)).toEqual({
      days: ["2026-11-16", "2026-11-17", "2026-11-18"],
      pushes: [45, 72, 86],
      filling: ["2026-11-18"],
      children: ["inductor", "dynamo"],
      rest: false,
      labels: ["x", "y"],
      cells: [
        [0, 0, 0, 2, 1],
        [0, 0, 1, 0.5, 0],
        [1, 1, 0, 1, 0],
      ],
    });
  });

  test(`files past the ${SERIES_TOP} largest fold into one child '', their cells summed by day and label`, () => {
    const rows = Array.from({ length: SERIES_TOP + 3 }, (_, i) => ({
      day_utc: "2026-11-16",
      child: `test_${String(i).padStart(2, "0")}.py`,
      label: "x",
      runner_hours: 100 - i,
      main_runner_hours: 1,
    }));
    const out = compactSeries("f", RANGE, rows, DAYS);
    expect(out.rest).toBe(true);
    expect(out.children).toHaveLength(SERIES_TOP + 1);
    expect(out.children[SERIES_TOP]).toBe("");
    expect(out.cells[SERIES_TOP]).toEqual([
      0,
      SERIES_TOP,
      0,
      100 - SERIES_TOP + (99 - SERIES_TOP) + (98 - SERIES_TOP),
      3,
    ]);
    const total = (cells: number[][]) => cells.reduce((s, c) => s + c[3], 0);
    expect(total(out.cells)).toBe(rows.reduce((s, r) => s + r.runner_hours, 0));
    // Machines never fold.
    expect(compactSeries("m", RANGE, rows, DAYS).rest).toBe(false);
  });
});

describe("getCostSeries", () => {
  afterEach(() => jest.restoreAllMocks());

  test("asks the scope query by day and the range's days, none heavy, and echoes the request", async () => {
    const query = jest
      .spyOn(clickhouse, "queryClickhouse")
      .mockImplementation(async (_sql, _params, id) =>
        id === "tests_cost_series"
          ? [
              {
                day_utc: "2026-11-17",
                child: "NVIDIA L4",
                label: "x",
                runner_hours: 3,
                main_runner_hours: 1,
              },
            ]
          : DAYS
      );
    const trail = decodeTrail("o:inductor");
    const answer = await getCostSeries({
      repo: "pytorch/pytorch",
      trail,
      by: "m",
      ...RANGE,
      workflow: ["pull"],
    });
    expect(query.mock.calls.map((c) => c[2])).toEqual([
      "tests_cost_series",
      "tests_cost_series_days",
    ]);
    expect(query.mock.calls[0][0]).toBe(scopeQuery("days", trail, "m"));
    expect(query.mock.calls[1][0]).toBe(scopeDaysQuery("days"));
    expect(query.mock.calls[0][1]).toEqual({
      repo: "pytorch/pytorch",
      ...RANGE,
      workflows: ["pull"],
      pill_o: "inductor",
    });
    expect(query.mock.calls.map((c) => c[4])).toEqual([undefined, undefined]);
    expect(CostSeriesSchema.parse(answer)).toEqual(answer);
    expect(answer.cells).toEqual([[1, 0, 0, 3, 1]]);
    expect(seriesEcho(answer)).toBe(
      costSeriesUrl("pytorch/pytorch", ["pull"], trail, "m", RANGE)
    );
  });
});

function get(query: RawQuery) {
  return callRoute(GET, "/api/tests/cost/series", query);
}

describe("app/api/tests/cost/series", () => {
  afterEach(() => jest.restoreAllMocks());

  const ok = {
    repo: "pytorch/pytorch",
    trail: "m:Linux%20x86_64%20avx2",
    by: "o",
    from: "2026-10-08",
    to: "2026-11-18",
  };

  test.each([
    { ...ok, trail: "m:Linux x86_64 avx2" },
    { ...ok, by: "lanes" },
    { ...ok, from: "2026-11-19", to: "2026-11-18" },
    { ...ok, from: "2025-10-01" },
    { ...ok, from: "2026-02-30" },
    { ...ok, to: undefined },
    { ...ok, to: "2026-11-18..2026-11-19" },
  ])("rejects a bad trail, by or range before querying %j", async (query) => {
    const spy = jest.spyOn(clickhouse, "queryClickhouse");
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_parameters");
    expect(ErrorResponseSchema.parse(res.body)).toEqual(res.body);
    expect(spy).not.toHaveBeenCalled();
  });

  test("names to in a range too long", async () => {
    const res = await get({ ...ok, from: "2025-01-01" });
    expect(res.body.issues).toEqual([
      { path: ["to"], message: "from..to must span at most 400 days" },
    ]);
  });

  test("answers 400 days, cached privately for ten minutes, echoing the URL", async () => {
    jest.spyOn(clickhouse, "queryClickhouse").mockResolvedValue([]);
    const res = await get({ ...ok, from: "2025-10-15" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=600");
    expect(seriesEcho(res.body)).toBe(
      costSeriesUrl("pytorch/pytorch", [], decodeTrail(ok.trail), "o", {
        from: "2025-10-15",
        to: ok.to,
      })
    );
  });
});
