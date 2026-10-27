import { GET as getCommitRuns } from "app/api/tests/commit/[sha]/route";
import { GET as getTests } from "app/api/tests/route";
import { GET as getTestRuns } from "app/api/tests/test/[test_id]/runs/route";
import { CommitRunListPageSchema } from "lib/api/tests/commit/types";
import { RunListPageSchema } from "lib/api/tests/test/runs/types";
import { TestListPageSchema } from "lib/api/tests/types";
import * as clickhouse from "lib/clickhouse";
import { answerQueries, entityRow, testId } from "./fixtures";
import {
  answerRunQueries,
  attemptRow,
  ENV_VARS_ID,
  ENVIRONMENT_ID,
  groupRow,
  runRecord,
  runStats,
  STARTED_AT,
} from "./test/runs/fixtures";

const SHA = "0123456789ABCDEF0123456789ABCDEF01234567";
const FILTER_VALUES = ["a+b &=#/?Ü, value", ""];
const endpoints = [
  {
    name: "tests",
    path: "/api/tests",
    get: getTests,
    schema: TestListPageSchema,
    sort: "-last_run_at",
  },
  {
    name: "test runs",
    path: "/api/tests/test/000123/runs",
    get: (request: Request) =>
      getTestRuns(request, {
        params: Promise.resolve({
          test_id: new URL(request.url).pathname.split("/")[4],
        }),
      }),
    schema: RunListPageSchema,
    sort: "-started_at",
  },
  {
    name: "commit runs",
    path: `/api/tests/commit/${SHA}`,
    get: (request: Request) =>
      getCommitRuns(request, {
        params: Promise.resolve({
          sha: new URL(request.url).pathname.split("/")[4],
        }),
      }),
    schema: CommitRunListPageSchema,
    sort: "-started_at",
  },
];

describe.each(endpoints)("$name bidirectional navigation", (endpoint) => {
  let queryClickhouse: jest.SpyInstance;

  beforeEach(() => {
    queryClickhouse = jest.spyOn(clickhouse, "queryClickhouse");
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function answerPage(indices: number[], boundary: number[] = []) {
    if (endpoint.name === "tests") {
      answerQueries(queryClickhouse, {
        tests: indices.map((index) => entityRow(index)),
        boundary: boundary.map((index) => entityRow(index)),
      });
      return;
    }
    const records = indices.map((index) =>
      runRecord({
        tests_id: "123",
        github_workflow_job_id: String(index),
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      })
    );
    answerRunQueries(queryClickhouse, {
      boundary: boundary.map(() => groupRow()),
      page: records.map((record) =>
        groupRow({
          tests_id_string: record.tests_id,
          github_workflow_job_id_string: record.github_workflow_job_id,
          ...(endpoint.name === "commit runs"
            ? {
                sort_0: String(Date.parse(STARTED_AT)),
                sort_1: record.tests_id,
                sort_2: ENVIRONMENT_ID,
                sort_3: ENV_VARS_ID,
                sort_4: record.github_workflow_job_id,
              }
            : { sort_3: record.github_workflow_job_id }),
        })
      ),
      attempts: records.slice(0, 1).map(attemptRow),
      stats: runStats(["failed", "failed", "failed"]),
    });
  }

  test.each(["JSON", "bracket"])(
    "follows returned URLs with repeated filters and %s env vars through the final page",
    async (encoding) => {
      const original = new URL(endpoint.path, "https://custom.example:8443");
      if (endpoint.name !== "test runs") {
        original.searchParams.append("repo", "pytorch/pytorch");
      }
      original.searchParams.append("owner", "nn");
      original.searchParams.append("owner", "autograd");
      original.searchParams.append("owner", "nn");
      original.searchParams.append("search", "Test_case[a+b, Ü] & #");
      original.searchParams.append(
        "workflow_path",
        ".github/workflows/pull.yml"
      );
      original.searchParams.append(
        "workflow_path",
        ".github/workflows/trunk.yml"
      );
      if (encoding === "JSON") {
        original.searchParams.append(
          "env_vars",
          JSON.stringify({ MODE: FILTER_VALUES })
        );
      } else {
        for (const value of FILTER_VALUES) {
          original.searchParams.append("env_vars[MODE]", value);
        }
      }
      if (endpoint.name === "tests") {
        original.searchParams.append("ran_on", "pull_request,main");
      } else {
        original.searchParams.append("outcome", "failed");
        original.searchParams.append("outcome", "error");
        original.searchParams.append("outcome", "failed");
        original.searchParams.append("last_attempt_outcome", "passed");
        original.searchParams.append("last_attempt_outcome", "failed");
        // Path parameters override same-named query parameters on every page.
        original.searchParams.append(
          endpoint.name === "test runs" ? "test_id" : "sha",
          "ignored-query-value"
        );
      }
      original.searchParams.append("sort", endpoint.sort);
      original.searchParams.append("limit", "1");

      let currentUrl = original;
      let lastPage: any;
      for (let index = 1; index <= 3; index++) {
        answerPage(
          index < 3 ? [index, index + 1] : [index],
          index === 1 ? [] : [index - 1]
        );
        const response = await endpoint.get(new Request(currentUrl));
        const body = await response.json();
        expect(response.status).toBe(200);
        expect(endpoint.schema.parse(body)).toEqual(body);
        expect(body).not.toHaveProperty("next_cursor");
        expect(body).not.toHaveProperty("next_url");
        expect(body).not.toHaveProperty("next");
        expect(Object.keys(body.pagination).sort()).toEqual([
          "next",
          "previous",
        ]);
        expect(body.pagination.previous === null).toBe(index === 1);
        lastPage = body;
        if (endpoint.name === "tests") {
          expect(body.tests.map((entry: any) => entry.test.id)).toEqual([
            testId(index),
          ]);
        } else {
          expect(
            body.runs.map((run: any) => run.github_workflow.job_id)
          ).toEqual([String(index)]);
        }
        if (index === 3) {
          // Exactly limit rows remain; the last page has no continuation.
          expect(body.pagination.next).toBeNull();
          continue;
        }
        expect(Object.keys(body.pagination.next).sort()).toEqual([
          "cursor",
          "url",
        ]);
        expect(body.pagination.next.cursor).toEqual(expect.any(String));
        expect(body.pagination.next.cursor).not.toBe(
          currentUrl.searchParams.get("cursor")
        );
        expect(body.pagination.next.url).toMatch(/^\/api\/tests(?:\?|\/)/);
        const nextUrl = new URL(body.pagination.next.url, currentUrl);
        expect(nextUrl.origin).toBe(original.origin);
        expect(nextUrl.pathname).toBe(original.pathname);
        expect(
          [...nextUrl.searchParams].filter(([name]) => name !== "cursor")
        ).toEqual([...original.searchParams]);
        expect(nextUrl.searchParams.getAll("cursor")).toEqual([
          body.pagination.next.cursor,
        ]);
        currentUrl = nextUrl;
      }

      for (let index = 2; index >= 1; index--) {
        const previous = lastPage.pagination.previous;
        expect(Object.keys(previous).sort()).toEqual(["cursor", "url"]);
        const previousUrl = new URL(previous.url, currentUrl);
        expect(previousUrl.pathname).toBe(original.pathname);
        expect(
          [...previousUrl.searchParams].filter(([name]) => name !== "cursor")
        ).toEqual([...original.searchParams]);
        expect(previousUrl.searchParams.getAll("cursor")).toEqual([
          previous.cursor,
        ]);
        answerPage(index === 2 ? [2, 1] : [1], [index + 1]);
        const response = await endpoint.get(new Request(previousUrl));
        const body = await response.json();
        expect(response.status).toBe(200);
        expect(endpoint.schema.parse(body)).toEqual(body);
        expect(body.pagination.previous === null).toBe(index === 1);
        expect(body.pagination.next).not.toBeNull();
        expect(
          endpoint.name === "tests"
            ? body.tests.map((entry: any) => entry.test.id)
            : body.runs.map((run: any) => run.github_workflow.job_id)
        ).toEqual([endpoint.name === "tests" ? testId(index) : String(index)]);
        currentUrl = previousUrl;
        lastPage = body;
      }

      // Live data may disappear between pages; an empty continuation also ends.
      answerPage([]);
      const emptyResponse = await endpoint.get(new Request(currentUrl));
      const empty = await emptyResponse.json();
      expect(emptyResponse.status).toBe(200);
      expect(endpoint.schema.parse(empty)).toEqual(empty);
      expect(empty.pagination).toEqual({ next: null, previous: null });
      expect(empty.tests ?? empty.runs).toEqual([]);
    }
  );
  test("checks the opposite boundary again when live entries disappear", async () => {
    const original = new URL(endpoint.path, "https://hud.pytorch.org");
    if (endpoint.name !== "test runs")
      original.searchParams.set("repo", "pytorch/pytorch");
    original.searchParams.set("limit", "1");
    answerPage([1, 2]);
    const first = await (await endpoint.get(new Request(original))).json();
    const nextUrl = new URL(first.pagination.next.url, original);
    answerPage([2], []);
    const afterDeletion = await (
      await endpoint.get(new Request(nextUrl))
    ).json();
    expect(afterDeletion.pagination).toEqual({ next: null, previous: null });
    expect(afterDeletion.tests ?? afterDeletion.runs).toHaveLength(1);

    answerPage([2], [1]);
    const second = await (await endpoint.get(new Request(nextUrl))).json();
    const previousUrl = new URL(second.pagination.previous.url, original);
    answerPage([1], []);
    const beforeDeletion = await (
      await endpoint.get(new Request(previousUrl))
    ).json();
    expect(beforeDeletion.pagination).toEqual({ next: null, previous: null });
    expect(beforeDeletion.tests ?? beforeDeletion.runs).toHaveLength(1);
  });

  test("accepts existing forward cursors without direction", async () => {
    const original = new URL(endpoint.path, "https://hud.pytorch.org");
    if (endpoint.name !== "test runs")
      original.searchParams.set("repo", "pytorch/pytorch");
    original.searchParams.set("limit", "1");
    answerPage([1, 2]);
    const first = await (await endpoint.get(new Request(original))).json();
    const nextUrl = new URL(first.pagination.next.url, original);
    const token = JSON.parse(
      Buffer.from(first.pagination.next.cursor, "base64url").toString("utf8")
    );
    delete token.direction;
    nextUrl.searchParams.set(
      "cursor",
      Buffer.from(JSON.stringify(token)).toString("base64url")
    );
    answerPage([2], [1]);
    const response = await endpoint.get(new Request(nextUrl));
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page.pagination.next).toBeNull();
    expect(page.pagination.previous).not.toBeNull();
  });

  test("includes the opposite-boundary query in database timing", async () => {
    jest.useFakeTimers();
    const original = new URL(endpoint.path, "https://hud.pytorch.org");
    if (endpoint.name !== "test runs")
      original.searchParams.set("repo", "pytorch/pytorch");
    original.searchParams.set("limit", "1");
    answerPage([1, 2]);
    const first = await (await endpoint.get(new Request(original))).json();
    const nextUrl = new URL(first.pagination.next.url, original);
    answerPage([2], [1]);
    const answer = queryClickhouse.getMockImplementation()!;
    queryClickhouse.mockImplementation(async (sql, params, queryId) => {
      const delay = queryId.endsWith("_boundary")
        ? 11
        : queryId.endsWith("_page")
        ? 7
        : 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return answer(sql, params, queryId);
    });
    const pending = endpoint.get(new Request(nextUrl));
    await jest.runAllTimersAsync();
    const response = await pending;
    expect(response.status).toBe(200);
    expect((await response.json()).query_duration_ms).toBe(18);
  });

  test.each([null, "backward", 23, {}])(
    "rejects an invalid cursor direction %j",
    async (direction) => {
      const original = new URL(endpoint.path, "https://hud.pytorch.org");
      if (endpoint.name !== "test runs")
        original.searchParams.set("repo", "pytorch/pytorch");
      original.searchParams.set("limit", "1");
      answerPage([1, 2]);
      const first = await (await endpoint.get(new Request(original))).json();
      const nextUrl = new URL(first.pagination.next.url, original);
      const token = JSON.parse(
        Buffer.from(first.pagination.next.cursor, "base64url").toString("utf8")
      );
      token.direction = direction;
      nextUrl.searchParams.set(
        "cursor",
        Buffer.from(JSON.stringify(token)).toString("base64url")
      );
      queryClickhouse.mockClear();
      const response = await endpoint.get(new Request(nextUrl));
      expect(response.status).toBe(400);
      expect(await response.json()).toHaveProperty("code", "invalid_cursor");
      expect(queryClickhouse).not.toHaveBeenCalled();
    }
  );

  if (endpoint.name !== "tests") {
    test.each(["next", "previous"])(
      "clears %s links if selected attempts expire before expansion",
      async (direction) => {
        const original = new URL(endpoint.path, "https://hud.pytorch.org");
        if (endpoint.name === "commit runs")
          original.searchParams.set("repo", "pytorch/pytorch");
        original.searchParams.set("limit", "1");
        answerPage([1, 2]);
        const first = await (await endpoint.get(new Request(original))).json();
        const nextUrl = new URL(first.pagination.next.url, original);
        answerPage([2, 3], [1]);
        const second = await (await endpoint.get(new Request(nextUrl))).json();
        const url =
          direction === "next"
            ? nextUrl
            : new URL(second.pagination.previous.url, original);
        answerPage(direction === "next" ? [2, 3] : [1, 0], [3]);
        const answer = queryClickhouse.getMockImplementation()!;
        queryClickhouse.mockImplementation((sql, params, queryId) =>
          queryId === "api_run_attempts"
            ? Promise.resolve([])
            : answer(sql, params, queryId)
        );
        const response = await endpoint.get(new Request(url));
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.runs).toEqual([]);
        expect(body.pagination).toEqual({ next: null, previous: null });
        if (endpoint.name === "commit runs") expect(body.stats.total).toBe(3);
      }
    );
  }
});
