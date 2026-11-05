import { GET } from "app/api/tests/pull/[number]/route";
import {
  getPullRequestHead,
  HeadRunRow,
  newestHead,
  PullRequestRecordRow,
} from "lib/api/tests/pull/head";
import {
  buildPullRequestHeadRunsQuery,
  buildPullRequestRecordQuery,
} from "lib/api/tests/pull/query";
import { PullRequestHeadSchema } from "lib/api/tests/pull/types";
import * as clickhouse from "lib/clickhouse";
import { callRoute } from "test/api/routes";

jest.mock("lib/api/auth", () => ({
  requireGithubWriteAccess: (handler: unknown) => handler,
}));

const REPO = "pytorch/pytorch";
const ROUTE = "/api/tests/pull/{number}";
const BRANCH = "gh/jbschlosser/292/head";

// Heads of pull request 203277 on 2026-11-05, when its record still named
// c900f5f although b2bbfce had been pushed a minute later.
const OLDER = "c900f5fc0257ef7d9a7decb6e0665e034b1301ee";
const NEWER = "b2bbfce524a163c99bb1ad47909387679100688d";
const OLDEST = "fcc98326f0180d79b230614f37a34aa0d89ab6e2";

function record(
  overrides: Partial<PullRequestRecordRow> = {}
): PullRequestRecordRow {
  return {
    head_sha: NEWER,
    head_repo: REPO,
    head_branch: BRANCH,
    title: "[BE][Test] Trim mode OpInfo sample inputs",
    html_url: "https://github.com/pytorch/pytorch/pull/203277",
    ...overrides,
  };
}

function head(
  sha: string,
  newestRunId: number,
  overrides: Partial<HeadRunRow> = {}
): HeadRunRow {
  return {
    head_sha: sha,
    head_repo: REPO,
    head_branch: BRANCH,
    newest_run_id: newestRunId,
    ...overrides,
  };
}

function answer(
  queryClickhouse: jest.SpyInstance,
  answers: { record?: PullRequestRecordRow[]; heads?: HeadRunRow[] }
) {
  queryClickhouse.mockImplementation(async (_sql, _params, queryId) => {
    switch (queryId) {
      case "api_pull_request_record":
        return answers.record ?? [record()];
      case "api_pull_request_head_runs":
        return (
          answers.heads ?? [
            head(OLDEST, 42091000000),
            head(OLDER, 42092159938),
            head(NEWER, 42092400000),
          ]
        );
      default:
        throw new Error(`unexpected query ${queryId}`);
    }
  });
}

describe("GET /api/tests/pull/{number}", () => {
  let queryClickhouse: jest.SpyInstance;
  beforeEach(() => {
    queryClickhouse = jest.spyOn(clickhouse, "queryClickhouse");
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("answers with the pull request, its newest head and its page", async () => {
    answer(queryClickhouse, {});
    const res = await callRoute(GET, ROUTE, { number: "203277", repo: REPO });
    expect(res.status).toBe(200);
    expect(PullRequestHeadSchema.parse(res.body)).toEqual(res.body);
    expect(res.body).toEqual({
      number: 203277,
      title: "[BE][Test] Trim mode OpInfo sample inputs",
      url: "https://github.com/pytorch/pytorch/pull/203277",
      head_sha: NEWER,
      hud_url: "https://hud.pytorch.org/tests/pytorch/pytorch/pull/203277",
      query_duration_ms: expect.any(Number),
    });
    // Both reads, by number in the repository, and neither in the heavy
    // workload.
    expect(
      queryClickhouse.mock.calls.map((call) => [call[2], call[1], call[4]])
    ).toEqual(
      expect.arrayContaining([
        ["api_pull_request_record", { number: 203277, repo: REPO }, undefined],
        [
          "api_pull_request_head_runs",
          { number: 203277, repo: REPO },
          undefined,
        ],
      ])
    );
    expect(queryClickhouse).toHaveBeenCalledTimes(2);
  });

  test("a record that fell behind a push gives way to the head that ran since", async () => {
    answer(queryClickhouse, { record: [record({ head_sha: OLDER })] });
    const pullRequest = await getPullRequestHead({
      number: 203277,
      repo: REPO,
    });
    expect(pullRequest?.head_sha).toBe(NEWER);
  });

  test("a number with no pull request record is not found", async () => {
    answer(queryClickhouse, { record: [], heads: [] });
    const res = await callRoute(GET, ROUTE, { number: "1", repo: REPO });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: "Pull request not found",
      code: "not_found",
    });
  });

  test("a record without a page names GitHub's", async () => {
    answer(queryClickhouse, { record: [record({ html_url: "" })] });
    const pullRequest = await getPullRequestHead({
      number: 203277,
      repo: REPO,
    });
    expect(pullRequest?.url).toBe(
      "https://github.com/pytorch/pytorch/pull/203277"
    );
  });

  test("a failed read answers 500 without details", async () => {
    queryClickhouse.mockRejectedValue(new Error("connection reset"));
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await callRoute(GET, ROUTE, { number: "203277", repo: REPO });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: "Failed to find the pull request's head",
      code: "internal_error",
    });
    expect(error).toHaveBeenCalled();
  });
});

describe("newestHead", () => {
  test("is the record's head when no later head ran", () => {
    expect(
      newestHead(record({ head_sha: NEWER }), [head(OLDER, 1), head(NEWER, 2)])
    ).toBe(NEWER);
  });

  test("is the head whose run is newest when the record's head ran before it", () => {
    // A record that fell behind a push gives these rows. So does the one
    // case answered wrong: a pull request with a merge conflict pushed back
    // to OLDER, on which GitHub runs nothing, is answered NEWER.
    expect(
      newestHead(record({ head_sha: OLDER }), [
        head(NEWER, 3),
        head(OLDER, 2),
        head(OLDEST, 1),
      ])
    ).toBe(NEWER);
  });

  test("goes by the run, not by order: a head pushed again is newest again", () => {
    expect(
      newestHead(record({ head_sha: NEWER }), [head(NEWER, 2), head(OLDER, 3)])
    ).toBe(OLDER);
  });

  test("keeps the record's head when it never ran, as on a pull request with a merge conflict", () => {
    expect(
      newestHead(record({ head_sha: NEWER }), [head(OLDER, 2), head(OLDEST, 1)])
    ).toBe(NEWER);
    expect(newestHead(record({ head_sha: NEWER }), [])).toBe(NEWER);
  });

  test("counts only runs on the pull request's head repository and branch", () => {
    // The record's head ran on another branch (a pull request opened from
    // it), and a head of another repository's pull request with the same
    // number ran in a fork of that name: neither is this pull request's.
    expect(
      newestHead(record({ head_sha: NEWER }), [
        head(NEWER, 2),
        head(OLDER, 9, { head_branch: "gh/jbschlosser/293/head" }),
        head(OLDEST, 8, { head_repo: "someone/pytorch" }),
      ])
    ).toBe(NEWER);
    expect(
      newestHead(record({ head_sha: OLDER }), [
        head(OLDER, 9, { head_branch: "another-branch" }),
        head(NEWER, 2),
      ])
    ).toBe(OLDER);
  });
});

describe("the pull request reads", () => {
  // The columns each read answers with, by the names its row type gives
  // them: a key missing here, or one the type lacks, fails to compile, and
  // a column the SQL renames fails the test, where the mocked reads above
  // would pass and newestHead would quietly compare undefined.
  const RECORD_COLUMNS = {
    head_sha: true,
    head_repo: true,
    head_branch: true,
    title: true,
    html_url: true,
  } satisfies Record<keyof PullRequestRecordRow, true>;
  const HEAD_RUN_COLUMNS = {
    head_sha: true,
    head_repo: true,
    head_branch: true,
    newest_run_id: true,
  } satisfies Record<keyof HeadRunRow, true>;

  // A statement's output columns: its first SELECT list, each item's alias
  // or, without one, the item itself.
  function selectedColumns(sql: string): string[] {
    const list = sql.slice(
      sql.indexOf("SELECT") + "SELECT".length,
      sql.indexOf("\nFROM")
    );
    return list.split(",").map(
      (item) =>
        item
          .trim()
          .split(/\s+AS\s+/)
          .pop()!
    );
  }

  const query = { number: 203277, repo: REPO };

  test("the record is the latest of the number's in the repository, with the columns its row type names", () => {
    const recordQuery = buildPullRequestRecordQuery(query);
    expect(recordQuery.params).toEqual(query);
    expect(selectedColumns(recordQuery.sql)).toEqual(
      Object.keys(RECORD_COLUMNS)
    );
    expect(recordQuery.sql).toMatch(/FROM default\.pull_request\s/);
    expect(recordQuery.sql).toMatch(/WHERE number = \{number: Int64\}/);
    expect(recordQuery.sql).toMatch(/base\.repo\.full_name = \{repo: String\}/);
    expect(recordQuery.sql).toMatch(/ORDER BY updated_at DESC\s+LIMIT 1/);
  });

  test("the heads' runs are the repository's pull_request runs read by id through the head_sha view, per head, head repository and branch", () => {
    const headsQuery = buildPullRequestHeadRunsQuery(query);
    expect(headsQuery.params).toEqual(query);
    expect(selectedColumns(headsQuery.sql)).toEqual(
      Object.keys(HEAD_RUN_COLUMNS)
    );
    expect(headsQuery.sql).toMatch(/max\(id\) AS newest_run_id/);
    expect(headsQuery.sql).toMatch(
      /WHERE id IN \(\s+SELECT id\s+FROM materialized_views\.workflow_run_by_head_sha/
    );
    expect(headsQuery.sql).toMatch(
      /FROM materialized_views\.pr_by_sha\s+WHERE number = \{number: Int64\}/
    );
    expect(headsQuery.sql).toMatch(/AND event = 'pull_request'/);
    expect(headsQuery.sql).toMatch(
      /AND repository\.full_name = \{repo: String\}/
    );
    expect(headsQuery.sql).toMatch(/GROUP BY head_sha, head_repo, head_branch/);
  });
});
