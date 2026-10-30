import type { RawQuery } from "lib/api/parameters";
import {
  DEFAULT_HUD_ORIGIN,
  hudOrigin,
  testPageLinkForEntry,
  testPageLinkForGrid,
  testPageUrl,
  testsPageLink,
} from "lib/api/tests/pages/links";
import { parseTestListParams, TestListQuery } from "lib/api/tests/parameters";
import {
  parseRunsGridParams,
  RunsGridQuery,
} from "lib/api/tests/test/runs/parameters";

const TEST_ID = "1810441053902397612";
const TEST_PAGE = `${DEFAULT_HUD_ORIGIN}/tests/pytorch/pytorch/test/${TEST_ID}`;

// A list request as the handler parses it, cursor aside.
function listQuery(raw: RawQuery): TestListQuery {
  const parsed = parseTestListParams({ repo: "pytorch/pytorch", ...raw });
  if (!parsed.success) throw new Error(parsed.error.message);
  const { cursor: _cursor, ...query } = parsed.data;
  return query;
}

function gridQuery(raw: RawQuery): RunsGridQuery {
  const parsed = parseRunsGridParams({
    test_id: TEST_ID,
    group_by: "commit",
    ...raw,
  });
  if (!parsed.success) throw new Error(parsed.error.message);
  return parsed.data;
}

function search(url: string | null) {
  if (url === null) throw new Error("no link");
  return new URL(url).searchParams;
}

describe("hudOrigin", () => {
  const selfUrl = process.env.HUD_SELF_URL;
  afterEach(() => {
    if (selfUrl === undefined) delete process.env.HUD_SELF_URL;
    else process.env.HUD_SELF_URL = selfUrl;
  });

  test("is production unless the deployment names itself", () => {
    delete process.env.HUD_SELF_URL;
    expect(hudOrigin()).toBe("https://hud.pytorch.org");
    process.env.HUD_SELF_URL = "http://localhost:3000";
    expect(hudOrigin()).toBe("http://localhost:3000");
    expect(testPageUrl("pytorch/pytorch", "42")).toBe(
      "http://localhost:3000/tests/pytorch/pytorch/test/42"
    );
  });
});

describe("testsPageLink", () => {
  test("is the bare table for the list's defaults", () => {
    expect(testsPageLink(listQuery({}))).toBe(
      `${DEFAULT_HUD_ORIGIN}/tests/pytorch/pytorch`
    );
    expect(
      testsPageLink(listQuery({ window: "12h", ran_on: "main", limit: "5" }))
    ).toBe(`${DEFAULT_HUD_ORIGIN}/tests/pytorch/pytorch`);
  });

  test("carries the request's selection as the page reads it, paging dropped", () => {
    const params = search(
      testsPageLink(
        listQuery({
          window: "7d",
          ran_on: ["pull_request", "main"],
          accelerator: "cuda",
          device_count: ["4", "2"],
          language: ["python", "cpp"],
          file: "test/test_torch.py",
          search: "conv",
          sort: "-mean_passed_duration_milliseconds",
          limit: "1",
        })
      )
    );
    expect(Object.fromEntries(params)).toEqual({
      window: "7d",
      ran_on: "main,pull_request",
      accelerator: "cuda",
      // fromEntries keeps the last of a repeated parameter.
      device_count: "4",
      language: "python",
      file: "test/test_torch.py",
      search: "conv",
      sort: "-mean_passed_duration_milliseconds",
    });
    expect(params.getAll("device_count")).toEqual(["2", "4"]);
    expect(params.getAll("language")).toEqual(["cpp", "python"]);
    expect(params.has("limit")).toBe(false);
    expect(params.has("repo")).toBe(false);
  });

  test("spells an env_vars filter on TEST_CONFIG alone as test_config", () => {
    const params = search(
      testsPageLink(
        listQuery({ env_vars: '{"TEST_CONFIG":["slow","default"]}' })
      )
    );
    expect(params.getAll("test_config")).toEqual(["default", "slow"]);
    expect(params.has("env_vars")).toBe(false);
  });

  test("narrows test_config to what an env_vars filter on TEST_CONFIG beside it shares", () => {
    const params = search(
      testsPageLink(
        listQuery({
          env_vars: '{"TEST_CONFIG":["slow","inductor"]}',
          test_config: ["default", "slow"],
        })
      )
    );
    expect(params.getAll("test_config")).toEqual(["slow"]);
    expect(params.has("env_vars")).toBe(false);
    // Sharing nothing, the request selected nothing, which no page shows.
    expect(
      testsPageLink(
        listQuery({
          env_vars: '{"TEST_CONFIG":["slow"]}',
          test_config: "default",
        })
      )
    ).toBeNull();
  });

  test("is null when the request used a parameter the page lacks", () => {
    expect(
      testsPageLink(listQuery({ env_vars: '{"PYTORCH_TEST_WITH_SLOW":["1"]}' }))
    ).toBeNull();
    expect(
      testsPageLink(listQuery({ environments_id: "2081130751942693630" }))
    ).toBeNull();
    expect(
      testsPageLink(listQuery({ env_vars_id: "1688593832548410197" }))
    ).toBeNull();
  });
});

describe("testPageLinkForEntry", () => {
  const testRecord = { id: TEST_ID, repo: "pytorch/pytorch" } as const;

  test("opens the test's page on the list's window and sources, the configuration marked", () => {
    const url = testPageLinkForEntry(
      {
        test: testRecord as any,
        environment: { id: "2081130751942693630" } as any,
        env_vars: { id: "1688593832548410197" } as any,
      },
      { window: "12h", ran_on: ["main", "pull_request"] }
    );
    expect(url.startsWith(`${TEST_PAGE}?`)).toBe(true);
    expect(Object.fromEntries(search(url))).toEqual({
      window: "12h",
      ran_on: "main,pull_request",
      environment: "2081130751942693630",
      env_vars: "1688593832548410197",
    });
  });

  test("leaves the page's own defaults off and marks nothing without catalog rows", () => {
    expect(
      testPageLinkForEntry(
        { test: testRecord as any, environment: null, env_vars: null },
        { window: "3d", ran_on: ["main"] }
      )
    ).toBe(TEST_PAGE);
  });
});

describe("testPageLinkForGrid", () => {
  const repo = "pytorch/pytorch";

  test("spells the widest choices for what the request left out", () => {
    expect(
      Object.fromEntries(search(testPageLinkForGrid(repo, gridQuery({}))))
    ).toEqual({
      ran_on: "main,pull_request",
      window: "14d",
    });
    expect(
      testPageLinkForGrid(repo, gridQuery({ ran_on: "main", window: "3d" }))
    ).toBe(TEST_PAGE);
  });

  test("marks one configuration named by both its ids", () => {
    expect(
      Object.fromEntries(
        search(
          testPageLinkForGrid(
            repo,
            gridQuery({
              ran_on: "main",
              window: "7d",
              environments_id: "2081130751942693630",
              env_vars_id: "1688593832548410197",
            })
          )
        )
      )
    ).toEqual({
      window: "7d",
      environment: "2081130751942693630",
      env_vars: "1688593832548410197",
    });
  });

  test("ignores filters on the test itself, which one test's lanes all share", () => {
    const bare = testPageLinkForGrid(repo, gridQuery({}));
    expect(bare).not.toBeNull();
    for (const raw of [
      { file: "test/test_torch.py" },
      { suite: "TestTorch" },
      { case_name: "test_add" },
      { declared_case_name: "test_add" },
      { language: "python" },
      { owner: "module: tests" },
    ]) {
      expect(testPageLinkForGrid(repo, gridQuery(raw))).toBe(bare);
    }
  });

  test("is null without a repository or for narrowing the page cannot show", () => {
    expect(testPageLinkForGrid(undefined, gridQuery({}))).toBeNull();
    expect(
      testPageLinkForGrid(
        repo,
        gridQuery({ environments_id: ["1", "2"], env_vars_id: "7" })
      )
    ).toBeNull();
    expect(
      testPageLinkForGrid(repo, gridQuery({ environments_id: "1" }))
    ).toBeNull();
    expect(
      testPageLinkForGrid(repo, gridQuery({ accelerator: "cuda" }))
    ).toBeNull();
    expect(
      testPageLinkForGrid(repo, gridQuery({ device_count: "2" }))
    ).toBeNull();
    expect(
      testPageLinkForGrid(
        repo,
        gridQuery({ workflow_path: ".github/workflows/pull.yml" })
      )
    ).toBeNull();
    expect(
      testPageLinkForGrid(
        repo,
        gridQuery({ env_vars: '{"TEST_CONFIG":["slow"]}' })
      )
    ).toBeNull();
  });
});
