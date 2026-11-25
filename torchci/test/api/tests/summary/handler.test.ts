import { GET } from "app/api/tests/summary/route";
import type { RawQuery } from "lib/api/parameters";
import { ErrorResponseSchema } from "lib/api/schema";
import { TEST_VIEWS } from "lib/api/tests/options/views";
import {
  buildFigureStatements,
  buildTestRecordQuery,
  figureColumns,
} from "lib/api/tests/summary/query";
import {
  figureListQuery,
  FIGURES_KEPT_SECONDS,
  summaryStatements,
} from "lib/api/tests/summary/summary";
import { TestSummarySchema } from "lib/api/tests/summary/types";
import * as clickhouse from "lib/clickhouse";
import { callRoute } from "test/api/routes";
import { REFRESHED_AT, testId, testRow } from "../fixtures";

// The routes are behind the GitHub gate, which has its own tests (auth.test.ts);
// here the handlers answer as themselves.
jest.mock("lib/api/auth", () => ({
  requireGithubWriteAccess: (handler: unknown) => handler,
}));

const REPO = "pytorch/pytorch";
const PREFIX = "api_tests_summary_";

function get(query: RawQuery = {}) {
  return callRoute(GET, "/api/tests/summary", { repo: REPO, ...query });
}

// The count each count view's statement answers with.
const COUNTS: Record<string, number> = {
  unhealthy: 20,
  blocking_viable_strict: 3,
  flaky_main: 32,
  flaky_pull_requests: 118,
};
const SLOWEST_MILLISECONDS = 1296000;
const TOTAL_MILLISECONDS = 4464000000;

// The statements that answer the figures, by the query ids they are sent
// under, each named for its views: the four over main's rows in the window
// asked for, and the two views that have a statement to themselves.
const MAIN = `${PREFIX}unhealthy__flaky_main__slowest__most_ci_time`;
const BLOCKING = `${PREFIX}blocking_viable_strict`;
const PULL_REQUESTS = `${PREFIX}flaky_pull_requests`;
const STATEMENTS = [MAIN, BLOCKING, PULL_REQUESTS];
// In another window the first view, which keeps the list's default window,
// is read alone, and the three other views of main share a statement.
const UNHEALTHY = `${PREFIX}unhealthy`;
const MAIN_ELSEWHERE = `${PREFIX}flaky_main__slowest__most_ci_time`;
const STATEMENTS_ELSEWHERE = [
  UNHEALTHY,
  BLOCKING,
  MAIN_ELSEWHERE,
  PULL_REQUESTS,
];
const SLOWEST_TEST = `${PREFIX}slowest_test`;

// The one row a figures statement answers with: each of its views' figures,
// in the columns of the view's position among the views.
function figuresRow(
  queryId: string,
  write: (_value: number) => number | string = (value) => value
): Record<string, unknown> {
  const row: Record<string, unknown> = { generation: REFRESHED_AT };
  for (const id of queryId.slice(PREFIX.length).split("__")) {
    const index = TEST_VIEWS.findIndex((view) => view.id === id);
    if (index < 0) throw new Error(`Unexpected query: ${queryId}`);
    const columns = figureColumns(index);
    switch (TEST_VIEWS[index].figure.kind) {
      case "count":
        row[columns.count] = write(COUNTS[id]);
        break;
      case "slowest":
        row[columns.duration] = write(SLOWEST_MILLISECONDS);
        row[columns.testsId] = testId(7);
        break;
      case "total_duration":
        row[columns.duration] = write(TOTAL_MILLISECONDS);
        break;
    }
  }
  return row;
}

// Every statement the summary makes, answered by its query id.
function answer(
  queryClickhouse: jest.SpyInstance,
  answers: Record<string, unknown[]> = {}
) {
  queryClickhouse.mockImplementation(
    async (_sql: string, _params: unknown, queryId: string) => {
      if (queryId in answers) return answers[queryId];
      if (queryId === "api_tests_generation") {
        return [{ refreshed_at: REFRESHED_AT }];
      }
      if (queryId === SLOWEST_TEST) return [testRow(7)];
      if ([...STATEMENTS, ...STATEMENTS_ELSEWHERE].includes(queryId)) {
        return [figuresRow(queryId)];
      }
      throw new Error(`Unexpected query: ${queryId}`);
    }
  );
}

// The statement sent under a query id: its SQL, its bindings, and whether
// and how the server may keep the answer.
function sent(queryClickhouse: jest.SpyInstance, queryId: string) {
  const calls = queryClickhouse.mock.calls.filter(([, , id]) => id === queryId);
  expect({ queryId, calls: calls.length }).toEqual({ queryId, calls: 1 });
  const [sql, params, , useQueryCache, settings] = calls[0];
  return { sql, params, useQueryCache, settings };
}

describe("GET /api/tests/summary", () => {
  let queryClickhouse: jest.SpyInstance;

  beforeEach(() => {
    queryClickhouse = jest.spyOn(clickhouse, "queryClickhouse");
    answer(queryClickhouse);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("answers every view of the options with its figure, in their order", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(TestSummarySchema.parse(res.body)).toEqual(res.body);
    expect(res.body.views.map((figure: any) => figure.id)).toEqual(
      TEST_VIEWS.map((view) => view.id)
    );
    const byId = Object.fromEntries(
      res.body.views.map((figure: any) => [figure.id, figure])
    );
    for (const [id, count] of Object.entries(COUNTS)) {
      expect(byId[id]).toMatchObject({
        kind: "count",
        // The list's default window, but for the view that sets its own.
        window: id === "blocking_viable_strict" ? "12h" : "3h",
        count,
        duration_milliseconds: null,
        test: null,
      });
    }
    expect(byId.slowest).toMatchObject({
      kind: "slowest",
      window: "3h",
      count: null,
      duration_milliseconds: SLOWEST_MILLISECONDS,
      test: {
        id: testId(7),
        hud_url: `https://hud.pytorch.org/tests/pytorch/pytorch/test/${testId(
          7
        )}`,
        repo: REPO,
        file: "test/test_torch.py",
        suite: "TestTorch",
        case_name: "test_case_0007",
        declared_case_name: "test_case",
        language: "python",
        first_seen_at: "2026-10-14T06:57:57.812Z",
      },
    });
    expect(byId.most_ci_time).toMatchObject({
      kind: "total_duration",
      window: "3h",
      count: null,
      duration_milliseconds: TOTAL_MILLISECONDS,
      test: null,
    });
    expect(res.body.refreshed_at).toBe(REFRESHED_AT);
    expect(res.body.query_duration_ms).toBeGreaterThanOrEqual(0);
    // Three statements for the six figures, the slowest test's row, and the
    // generation.
    expect(queryClickhouse.mock.calls.map(([, , id]) => id).sort()).toEqual(
      ["api_tests_generation", SLOWEST_TEST, ...STATEMENTS].sort()
    );
  });

  test("reads every figure over the list request its view and its own filters stand for, figures over the same rows in one statement", async () => {
    await get();
    // Each view's figure is read over its list request, and those that
    // select the same rows are read together.
    const expected = buildFigureStatements(
      TEST_VIEWS.map((view) => ({
        kind: view.figure.kind,
        query: figureListQuery(view, { repo: REPO, window: "3h" }),
      })),
      REFRESHED_AT
    );
    expect(
      expected.map(({ figures }) =>
        figures.map((index) => TEST_VIEWS[index].id)
      )
    ).toEqual([
      ["unhealthy", "flaky_main", "slowest", "most_ci_time"],
      ["blocking_viable_strict"],
      ["flaky_pull_requests"],
    ]);
    expected.forEach((statement, index) => {
      const { sql, params } = sent(queryClickhouse, STATEMENTS[index]);
      expect(sql).toBe(statement.sql);
      expect(params).toEqual(statement.params);
    });
    // What the summary says it sends is what it sends.
    expect(
      summaryStatements({ repo: REPO, window: "3h" }, REFRESHED_AT).map(
        ({ queryId, statement, views }) => ({
          queryId,
          sql: statement.sql,
          views: views.map((view) => view.id),
        })
      )
    ).toEqual(
      expected.map((statement, index) => ({
        queryId: STATEMENTS[index],
        sql: statement.sql,
        views: statement.figures.map((figure) => TEST_VIEWS[figure].id),
      }))
    );
    // The first view lists every entry; its figure counts the unhealthy
    // ones, failing or flaky. Each figure's filters are bound under its own
    // names, and the statements read the list's default window.
    expect(TEST_VIEWS[0].params).not.toHaveProperty("status");
    expect(sent(queryClickhouse, MAIN).params).toEqual({
      repo: REPO,
      ran_on: ["main"],
      window: "3h",
      figure_0_filter_status: ["failing", "flaky"],
      figure_2_filter_status: ["flaky"],
      generation: REFRESHED_AT,
    });
    // The view that sets its own window is read over it.
    expect(sent(queryClickhouse, BLOCKING).params).toEqual({
      repo: REPO,
      ran_on: ["main"],
      window: "12h",
      figure_1_filter_status: ["failing"],
      figure_1_filter_workflow_path: [
        ".github/workflows/pull.yml",
        ".github/workflows/trunk.yml",
      ],
      generation: REFRESHED_AT,
    });
    expect(sent(queryClickhouse, PULL_REQUESTS).params).toEqual({
      repo: REPO,
      ran_on: ["pull_request"],
      window: "3h",
      figure_3_filter_status: ["flaky"],
      generation: REFRESHED_AT,
    });
    // The slowest entry's test is then read by its id.
    const record = buildTestRecordQuery(testId(7));
    const lookup = sent(queryClickhouse, SLOWEST_TEST);
    expect(lookup.sql).toBe(record.sql);
    expect(lookup.params).toEqual({ test_id: testId(7) });
  });

  test("reads the figures over the window and languages asked for, a view's own window standing", async () => {
    const res = await get({ window: "7d", language: ["python", "cpp"] });
    expect(res.status).toBe(200);
    for (const [id, window] of [
      // The two views that set their own window are read over it: the
      // first, the list's defaults, over the default window, and so alone.
      [UNHEALTHY, "3h"],
      [BLOCKING, "12h"],
      [MAIN_ELSEWHERE, "7d"],
      [PULL_REQUESTS, "7d"],
    ]) {
      const { params } = sent(queryClickhouse, id);
      expect({ id, window: params.window }).toEqual({ id, window });
      // Repeated values are a set, sorted.
      expect(params.filter_language).toEqual(["cpp", "python"]);
    }
    // Nothing else: the statement the views of main share in the default
    // window is not sent in another.
    expect(
      queryClickhouse.mock.calls
        .map(([, , id]) => id)
        .filter((id) => id.startsWith(PREFIX) && id !== SLOWEST_TEST)
        .sort()
    ).toEqual([...STATEMENTS_ELSEWHERE].sort());
    const windows = Object.fromEntries(
      res.body.views.map((figure: any) => [figure.id, figure.window])
    );
    expect(windows).toEqual({
      unhealthy: "3h",
      blocking_viable_strict: "12h",
      flaky_main: "7d",
      flaky_pull_requests: "7d",
      slowest: "7d",
      most_ci_time: "7d",
    });
  });

  test("links the page that shows the figures, and for each view the page that lists it", async () => {
    const res = await get({ window: "7d", language: ["python"] });
    const page = "https://hud.pytorch.org/tests/pytorch/pytorch";
    const link = (url: string) => {
      const parsed = new URL(url);
      return {
        page: `${parsed.origin}${parsed.pathname}`,
        params: Array.from(parsed.searchParams).sort(),
      };
    };
    expect(link(res.body.hud_url)).toEqual({
      page,
      params: [
        ["language", "python"],
        ["window", "7d"],
      ],
    });
    const byId = Object.fromEntries(
      res.body.views.map((figure: any) => [figure.id, link(figure.hud_url)])
    );
    // The first view is the list's defaults, their window included, so its
    // link names no window: the page a reader arrives on, in the languages
    // asked for, not that page narrowed to the unhealthy entries the figure
    // counts, and not the 7 days the summary was asked for.
    expect(byId.unhealthy).toEqual({
      page,
      params: [["language", "python"]],
    });
    // Its own window, 12 hours, is not the list's default, so the link
    // names it.
    expect(byId.blocking_viable_strict).toEqual({
      page,
      params: [
        ["language", "python"],
        ["status", "failing"],
        ["window", "12h"],
        ["workflow_path", ".github/workflows/pull.yml"],
        ["workflow_path", ".github/workflows/trunk.yml"],
      ],
    });
    expect(byId.flaky_pull_requests).toEqual({
      page,
      params: [
        ["language", "python"],
        ["ran_on", "pull_request"],
        ["sort", "-flaky_runs,-flaky_rate"],
        ["status", "flaky"],
        ["window", "7d"],
      ],
    });
    expect(byId.slowest).toEqual({
      page,
      params: [
        ["language", "python"],
        ["sort", "-mean_passed_duration_milliseconds"],
        ["window", "7d"],
      ],
    });
  });

  test("lets the server keep each statement's answer briefly, and runs none in the heavy workload", async () => {
    await get();
    expect(FIGURES_KEPT_SECONDS).toBe(60);
    for (const id of [...STATEMENTS, SLOWEST_TEST]) {
      const { useQueryCache, settings } = sent(queryClickhouse, id);
      expect({ id, useQueryCache, settings }).toEqual({
        id,
        useQueryCache: true,
        settings: { query_cache_ttl: FIGURES_KEPT_SECONDS },
      });
    }
    // The refresh timestamp is read live: it is what the figures are kept by.
    const generation = sent(queryClickhouse, "api_tests_generation");
    expect(generation.useQueryCache).toBeUndefined();
    expect(generation.settings).toBeUndefined();
  });

  // A figure the server kept from one refresh must not answer after the
  // next. The cache keys a kept answer by the statement with its bindings,
  // so each figure binds the refresh the summary read first.
  test("reads the refresh first and asks for every figure at it", async () => {
    const statements = async (refreshedAt: string) => {
      queryClickhouse.mockClear();
      answer(queryClickhouse, {
        api_tests_generation: [{ refreshed_at: refreshedAt }],
      });
      const res = await get();
      expect(res.status).toBe(200);
      expect(res.body.refreshed_at).toBe(refreshedAt);
      // Nothing is asked for before the refresh is known.
      expect(queryClickhouse.mock.calls[0][2]).toBe("api_tests_generation");
      return STATEMENTS.map((id) => sent(queryClickhouse, id));
    };
    const before = await statements("2026-10-25T12:00:00Z");
    const after = await statements("2026-10-25T12:15:00Z");
    expect(before).toHaveLength(3);
    before.forEach((statement, index) => {
      expect(statement.params.generation).toBe("2026-10-25T12:00:00Z");
      // The same statement at the next refresh, but for the refresh.
      expect(after[index].sql).toBe(statement.sql);
      expect(after[index].params).toEqual({
        ...statement.params,
        generation: "2026-10-25T12:15:00Z",
      });
    });
  });

  test("takes counts and durations as numbers when the database quotes them", async () => {
    answer(
      queryClickhouse,
      Object.fromEntries(
        STATEMENTS.map((id) => [id, [figuresRow(id, (value) => `${value}`)]])
      )
    );
    const res = await get();
    expect(TestSummarySchema.parse(res.body)).toEqual(res.body);
    const byId = Object.fromEntries(
      res.body.views.map((figure: any) => [figure.id, figure])
    );
    expect(byId.unhealthy.count).toBe(20);
    expect(byId.flaky_pull_requests.count).toBe(118);
    expect(byId.slowest.duration_milliseconds).toBe(1296000);
    expect(byId.most_ci_time.duration_milliseconds).toBe(4464000000);
  });

  // Each statement answers one row of aggregates whatever it reads. Over no
  // rows, the counts and the total are 0, the largest mean is NULL and the
  // ID beside it names no test.
  test("answers zero counts and no slowest test for a repository without health", async () => {
    const slowest = figureColumns(
      TEST_VIEWS.findIndex((view) => view.id === "slowest")
    );
    answer(
      queryClickhouse,
      Object.fromEntries(
        STATEMENTS.map((id) => [
          id,
          [
            {
              ...figuresRow(id, () => 0),
              ...(id === MAIN
                ? { [slowest.duration]: null, [slowest.testsId]: "0" }
                : {}),
            },
          ],
        ])
      )
    );
    const res = await get({ repo: "nobody/nothing" });
    expect(res.status).toBe(200);
    expect(TestSummarySchema.parse(res.body)).toEqual(res.body);
    for (const figure of res.body.views) {
      const view = TEST_VIEWS.find((candidate) => candidate.id === figure.id);
      expect(figure).toMatchObject({
        count: view?.figure.kind === "count" ? 0 : null,
        duration_milliseconds:
          view?.figure.kind === "total_duration" ? 0 : null,
        test: null,
      });
    }
    // No slowest entry, so no test to look up.
    expect(queryClickhouse.mock.calls.map(([, , id]) => id)).not.toContain(
      SLOWEST_TEST
    );
  });

  test("answers the same when the database has no rows at all", async () => {
    queryClickhouse.mockResolvedValue([]);
    const res = await get({ repo: "nobody/nothing" });
    expect(res.status).toBe(200);
    expect(TestSummarySchema.parse(res.body)).toEqual(res.body);
    for (const figure of res.body.views) {
      const view = TEST_VIEWS.find((candidate) => candidate.id === figure.id);
      expect(figure).toMatchObject({
        count: view?.figure.kind === "count" ? 0 : null,
        duration_milliseconds:
          view?.figure.kind === "total_duration" ? 0 : null,
        test: null,
      });
    }
    // An empty health table has no refresh timestamp either: the figures
    // are asked for at none.
    expect(res.body.refreshed_at).toBeNull();
    expect(sent(queryClickhouse, MAIN).params.generation).toBe("");
    expect(queryClickhouse.mock.calls.map(([, , id]) => id)).not.toContain(
      SLOWEST_TEST
    );
  });

  test("keeps the slowest duration when the catalog has no row for its test", async () => {
    answer(queryClickhouse, { [SLOWEST_TEST]: [] });
    const res = await get();
    expect(res.status).toBe(200);
    const slowest = res.body.views.find(
      (figure: any) => figure.id === "slowest"
    );
    expect(slowest).toMatchObject({
      duration_milliseconds: SLOWEST_MILLISECONDS,
      test: null,
    });
  });

  test("answers 500 without details when a figure cannot be read", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    queryClickhouse.mockImplementation(
      async (_sql: string, _params: unknown, queryId: string) => {
        if (queryId === PULL_REQUESTS) {
          throw new Error("connection refused");
        }
        return [];
      }
    );
    const res = await get();
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("internal_error");
    expect(res.body.error).not.toContain("connection refused");
    expect(ErrorResponseSchema.parse(res.body)).toEqual(res.body);
    expect(error).toHaveBeenCalled();
  });

  test("answers 500 when the refresh timestamp cannot be read", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    answer(queryClickhouse);
    const figures = queryClickhouse.getMockImplementation();
    queryClickhouse.mockImplementation(async (...args: unknown[]) => {
      if (args[2] === "api_tests_generation") {
        throw new Error("connection refused");
      }
      return figures?.(...args);
    });
    const res = await get();
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("internal_error");
    expect(error).toHaveBeenCalled();
    // With no refresh to ask for them at, no figure is read.
    expect(queryClickhouse).toHaveBeenCalledTimes(1);
  });

  test.each([
    [{ repo: undefined }, ["repo"]],
    [{ repo: "pytorch" }, ["repo"]],
    [{ window: "2d" }, ["window"]],
    [{ window: ["12h", "7d"] }, ["window"]],
    [{ language: "rust" }, ["language", 0]],
    // What a view sets is not the caller's to say.
    [{ ran_on: "main" }, ["ran_on"]],
    [{ status: "failing" }, ["status"]],
    [{ sort: "-runs" }, ["sort"]],
    [{ limit: "10" }, ["limit"]],
    [{ cursor: "anything" }, ["cursor"]],
    [{ view: "unhealthy" }, ["view"]],
  ] as [RawQuery, (string | number)[]][])(
    "rejects %j without querying",
    async (query, path) => {
      const res = await get(query);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_parameters");
      expect(res.body.issues[0].path).toEqual(path);
      expect(ErrorResponseSchema.parse(res.body)).toEqual(res.body);
      expect(queryClickhouse).not.toHaveBeenCalled();
    }
  );
});
