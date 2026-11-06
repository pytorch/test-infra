import { GET } from "app/api/tests/cost/changes/route";
import { buildOpenApiDocument } from "lib/api/openapi";
import type { RawQuery } from "lib/api/parameters";
import { ErrorResponseSchema } from "lib/api/schema";
import * as changesModule from "lib/api/tests/cost/changes";
import { compactChanges, getCostChanges } from "lib/api/tests/cost/changes";
import {
  costChangesQueryParameters,
  MAX_CHANGE_DAYS,
  parseDayRange,
} from "lib/api/tests/cost/parameters";
import { changesDaysQuery, changesQuery } from "lib/api/tests/cost/query";
import { CostChangesSchema } from "lib/api/tests/cost/types";
import * as clickhouse from "lib/clickhouse";
import { callRoute } from "test/api/routes";
import CHANGES_JSON from "test/tests/cost/changes.json";

// The routes are behind the GitHub gate, which has its own tests (auth.test.ts);
// here the handlers answer as themselves.
jest.mock("lib/api/auth", () => ({
  requireGithubWriteAccess: (handler: unknown) => handler,
}));

// The example answer beside the cost page's tests.
const ANSWER = CostChangesSchema.parse(CHANGES_JSON);
const A = "2026-10-22..2026-10-28";
const B = "2026-10-29..2026-11-04";

describe("the periods compared", () => {
  test("from..to, both real days in order, at most 400 days", () => {
    expect(parseDayRange("2026-10-22..2026-10-28")).toEqual({
      from: "2026-10-22",
      to: "2026-10-28",
    });
    expect(parseDayRange("2026-11-04..2026-11-04")).toEqual({
      from: "2026-11-04",
      to: "2026-11-04",
    });
    // A leap day, and 400 days to the day.
    expect(parseDayRange("2028-02-29..2028-02-29")).not.toBeNull();
    expect(parseDayRange("2026-01-01..2027-02-04")).not.toBeNull();
    expect(MAX_CHANGE_DAYS).toBe(400);
    for (const bad of [
      "2026-01-01..2027-02-05",
      "2026-10-28..2026-10-22",
      "2026-02-30..2026-03-01",
      "2026-10-22",
      "2026-10-22...2026-10-28",
      "2026-10-22..2026-10-28 ",
      "22-10-2026..28-10-2026",
    ]) {
      expect(parseDayRange(bad)).toBeNull();
    }
  });
});

describe("compactChanges", () => {
  const row = (side: number, label: string, h: number, main = 0) => ({
    side,
    label,
    runner_hours: h,
    main_runner_hours: main,
  });

  test("names every label once, most runner-hours first, then by name; cells as sorted index tuples with their push:main hours, empty ones left out; days in order, their pushes numbers", () => {
    expect(
      compactChanges(
        [
          row(1, "linux.2xlarge", 1, 0.5),
          row(0, "linux.g6", 5, 2),
          row(0, "linux.4xlarge", 0),
          {
            side: "1",
            label: "linux.g6",
            runner_hours: "1",
            main_runner_hours: "0",
          },
          row(0, "linux.2xlarge", 5),
        ],
        [
          { day_utc: "2026-11-03", pushes: "8" },
          { day_utc: "2026-11-02", pushes: 10 },
        ]
      )
    ).toEqual({
      days: [
        ["2026-11-02", 10],
        ["2026-11-03", 8],
      ],
      labels: ["linux.2xlarge", "linux.g6"],
      cells: [
        [0, 0, 5, 0],
        [0, 1, 5, 2],
        [1, 0, 1, 0.5],
        [1, 1, 1, 0],
      ],
    });
  });

  test("loses no runner-hour: each side's cells sum to its rows, all and of pushes to main", () => {
    const out = compactChanges(
      [row(0, "a", 1.25, 1), row(0, "b", 2.5, 0.5), row(1, "a", 4, 3)],
      []
    );
    const side = (s: number, i: number) =>
      out.cells.filter((c) => c[0] === s).reduce((t, c) => t + c[i], 0);
    expect([side(0, 2), side(1, 2)]).toEqual([3.75, 4]);
    expect([side(0, 3), side(1, 3)]).toEqual([1.5, 3]);
  });
});

describe("getCostChanges", () => {
  afterEach(() => jest.restoreAllMocks());

  test("for some owners, asks their shares by runner label and the days with their pushes, none heavy, and answers its schema", async () => {
    const query = jest
      .spyOn(clickhouse, "queryClickhouse")
      .mockImplementation(async (_sql, _params, id) =>
        id === "tests_cost_changes"
          ? [
              {
                side: 1,
                label: "linux.g6",
                runner_hours: 4,
                main_runner_hours: 1,
              },
            ]
          : [{ day_utc: "2026-11-02", pushes: "48" }]
      );
    const answer = await getCostChanges({
      repo: "pytorch/pytorch",
      a: A,
      b: B,
      owner: ["inductor"],
      workflow: ["pull", "trunk"],
    });
    expect(query.mock.calls.map((c) => c[2])).toEqual([
      "tests_cost_changes",
      "tests_cost_changes_days",
    ]);
    expect(query.mock.calls[0][0]).toBe(changesQuery(true));
    expect(query.mock.calls[1][0]).toBe(changesDaysQuery());
    const periods = {
      repo: "pytorch/pytorch",
      a_from: "2026-10-22",
      a_to: "2026-10-28",
      b_from: "2026-10-29",
      b_to: "2026-11-04",
    };
    expect(query.mock.calls[0][1]).toEqual({
      ...periods,
      workflows: ["pull", "trunk"],
      owners: ["inductor"],
    });
    expect(query.mock.calls[1][1]).toEqual(periods);
    // Under half a second each: not heavy.
    expect(query.mock.calls.map((c) => c[4])).toEqual([undefined, undefined]);
    expect(CostChangesSchema.safeParse(answer).success).toBe(true);
    expect(answer).toMatchObject({
      owners: ["inductor"],
      workflows: ["pull", "trunk"],
      a: { from: "2026-10-22", to: "2026-10-28" },
      b: { from: "2026-10-29", to: "2026-11-04" },
      days: [["2026-11-02", 48]],
      labels: ["linux.g6"],
      cells: [[1, 0, 4, 1]],
    });
  });

  test("for every owner, no owners join", async () => {
    const query = jest
      .spyOn(clickhouse, "queryClickhouse")
      .mockResolvedValue([]);
    const answer = await getCostChanges({
      repo: "pytorch/pytorch",
      a: A,
      b: B,
    });
    expect(query.mock.calls[0][0]).toBe(changesQuery(false));
    expect(query.mock.calls[0][1]).toMatchObject({ owners: [], workflows: [] });
    expect(answer.owners).toEqual([]);
    expect(answer.cells).toEqual([]);
  });
});

function get(query: RawQuery = { repo: "pytorch/pytorch", a: A, b: B }) {
  return callRoute(GET, "/api/tests/cost/changes", query);
}

describe("app/api/tests/cost/changes", () => {
  let getChanges: jest.SpyInstance;

  beforeEach(() => {
    getChanges = jest
      .spyOn(changesModule, "getCostChanges")
      .mockResolvedValue(ANSWER);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const base = { repo: "pytorch/pytorch", a: A, b: B };
  test.each([
    {},
    { repo: "pytorch/pytorch", a: A },
    { repo: "pytorch/pytorch", b: B },
    { ...base, a: "2026-10-28..2026-10-22" },
    { ...base, b: "2026-01-01..2027-12-31" },
    { ...base, a: "last week" },
    { ...base, a: [A, B] },
    { ...base, owner: "" },
    { ...base, owner: "x".repeat(201) },
    { ...base, owner: Array.from({ length: 51 }, (_, i) => `o${i}`) },
    { ...base, workflow: "" },
    { ...base, rollup: "day" },
    { ...base, window: "7d" },
    // Rates stay in the browser.
    { ...base, rates: "{}" },
  ])(
    "rejects invalid or unsupported parameters before querying %j",
    async (query) => {
      const res = await get(query);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_parameters");
      expect(ErrorResponseSchema.parse(res.body)).toEqual(res.body);
      expect(getChanges).not.toHaveBeenCalled();
    }
  );

  test("answers every owner in every workflow by default, cached privately for ten minutes", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(getChanges).toHaveBeenCalledWith(base);
    expect(res.body).toEqual(ANSWER);
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=600");
    expect(res.headers.get("Vary")).toBe("Authorization, Cookie");
  });

  test("takes owners and workflows once each, sorted", async () => {
    const res = await get({
      ...base,
      owner: ["inductor", "dynamo", "inductor"],
      workflow: ["trunk", "pull"],
    });
    expect(res.status).toBe(200);
    expect(getChanges).toHaveBeenCalledWith({
      ...base,
      owner: ["dynamo", "inductor"],
      workflow: ["pull", "trunk"],
    });
  });

  test("logs query failures and answers 500 without exposing details", async () => {
    getChanges.mockRejectedValue(
      new Error("private database connection failed")
    );
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const res = await get();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: "Failed to compare the runner-hours",
      code: "internal_error",
    });
    expect(consoleError).toHaveBeenCalled();
  });
});

describe("changes OpenAPI", () => {
  const document = buildOpenApiDocument();
  const operation = (document.paths["/api/tests/cost/changes"] as any).get;
  const schemas = document.components.schemas as Record<string, any>;

  test("documents the repository, the two periods, repeated owners and workflows", () => {
    expect(operation.operationId).toBe("getTestsCostChanges");
    expect(operation.tags).toEqual(["tests"]);
    expect(operation.parameters).toEqual(costChangesQueryParameters());
    expect(operation.parameters.map((p: any) => p.name)).toEqual([
      "repo",
      "a",
      "b",
      "owner",
      "workflow",
    ]);
    for (const name of ["repo", "a", "b"]) {
      expect(
        operation.parameters.find((p: any) => p.name === name).required
      ).toBe(true);
    }
  });

  test("answers CostChanges, compact, with no prices; errors for bad parameters and failures, no 429", () => {
    expect(
      operation.responses["200"].content["application/json"].schema
    ).toEqual({ $ref: "#/components/schemas/CostChanges" });
    for (const status of ["400", "500"]) {
      expect(
        operation.responses[status].content["application/json"].schema
      ).toEqual({ $ref: "#/components/schemas/ErrorResponse" });
    }
    expect(operation.responses).not.toHaveProperty("429");
    expect(operation.description).toMatch(/The API holds no prices/);
    expect(JSON.stringify(schemas.CostChanges.properties.cells)).toMatch(
      /\[side, label, runner_hours, main_runner_hours\]/
    );
    expect(schemas).not.toHaveProperty("ChangeBreakdown");
    expect(Object.keys(schemas.CostChanges.properties)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/cost|rate|price|budget/i)])
    );
  });
});
