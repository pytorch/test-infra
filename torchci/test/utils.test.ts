import {
  clearFilesChangedCache,
  getFilesChangedByPrCached,
  getOpenStackPrs,
  hasApprovedPullRuns,
  parseGhstackListing,
} from "lib/bot/utils";
import nock from "nock";
import { Probot } from "probot";
import * as utils from "./utils";

nock.disableNetConnect();

describe("utils: hasApprovedPullRuns", () => {
  let probot: Probot;
  let octokit = utils.testOctokit();
  let REPO = "pytorch/pytorch";
  let SHA = "random sha";

  beforeEach(() => {
    probot = utils.testProbot();
  });

  function mockRuns(
    runs: { conclusion: string; created_at?: string; updated_at?: string }[]
  ) {
    return nock("https://api.github.com")
      .get(`/repos/${REPO}/actions/runs?head_sha=${SHA}`)
      .reply(200, {
        workflow_runs: runs.map((run) => ({
          event: "pull_request",
          ...run,
        })),
      });
  }

  async function checkhasApprovedPullRunsReturns(value: boolean) {
    expect(await hasApprovedPullRuns(octokit, "pytorch", "pytorch", SHA)).toBe(
      value
    );
  }

  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  test("successful runs = good", async () => {
    mockRuns([{ conclusion: "success" }, { conclusion: "success" }]);
    await checkhasApprovedPullRunsReturns(true);
  });

  test("at least 1 action required run = bad", async () => {
    mockRuns([{ conclusion: "action_required" }, { conclusion: "success" }]);
    await checkhasApprovedPullRunsReturns(false);
  });

  test("no runs = bad", async () => {
    mockRuns([]);
    await checkhasApprovedPullRunsReturns(false);
  });

  test("one startup failure = bad", async () => {
    mockRuns([
      {
        conclusion: "failure",
        created_at: "time",
        updated_at: "time",
      },
    ]);
    await checkhasApprovedPullRunsReturns(false);
  });

  test("one startup failure and one action required = bad", async () => {
    mockRuns([
      {
        conclusion: "failure",
        created_at: "time",
        updated_at: "time",
      },
      { conclusion: "action_required" },
    ]);
    await checkhasApprovedPullRunsReturns(false);
  });

  test("one startup failure and one success = bad", async () => {
    mockRuns([
      {
        conclusion: "failure",
        created_at: "time",
        updated_at: "time",
      },
      { conclusion: "success" },
    ]);
    await checkhasApprovedPullRunsReturns(false);
  });
});

describe("utils: getFilesChangedByPrCached", () => {
  beforeEach(() => clearFilesChangedCache());
  afterEach(() => clearFilesChangedCache());

  test("dedupes by head sha; re-fetches on sha change or after clear", async () => {
    const octokit = {
      paginate: jest
        .fn()
        .mockResolvedValue([{ filename: "a.py" }, { filename: "b.py" }]),
    } as any;
    const call = (sha: string) =>
      getFilesChangedByPrCached(
        octokit,
        "delivery1",
        "pytorch",
        "pytorch",
        1,
        sha
      );

    expect(await call("sha1")).toEqual(["a.py", "b.py"]);
    expect(await call("sha1")).toEqual(["a.py", "b.py"]);
    expect(octokit.paginate).toHaveBeenCalledTimes(1);

    await call("sha2");
    expect(octokit.paginate).toHaveBeenCalledTimes(2);

    clearFilesChangedCache();
    await call("sha1");
    expect(octokit.paginate).toHaveBeenCalledTimes(3);
  });

  test("dedupes within one delivery; re-fetches across deliveries", async () => {
    const octokit = {
      paginate: jest.fn().mockResolvedValue([{ filename: "a.py" }]),
    } as any;
    const call = (deliveryId: string) =>
      getFilesChangedByPrCached(
        octokit,
        deliveryId,
        "pytorch",
        "pytorch",
        1,
        "sha1"
      );

    await call("delivery1");
    await call("delivery1");
    expect(octokit.paginate).toHaveBeenCalledTimes(1);

    await call("delivery2");
    expect(octokit.paginate).toHaveBeenCalledTimes(2);
  });

  test("a later delivery sees its own file list after a base retarget", async () => {
    const octokit = {
      paginate: jest
        .fn()
        .mockResolvedValueOnce([{ filename: "torch/csrc/foo.cpp" }])
        .mockResolvedValueOnce([{ filename: "docs/readme.md" }]),
    } as any;
    // Retargeting a PR's base fires pull_request.edited without moving
    // head.sha, so every key component except the delivery id is identical.
    const call = (deliveryId: string) =>
      getFilesChangedByPrCached(
        octokit,
        deliveryId,
        "pytorch",
        "pytorch",
        1,
        "sha1"
      );

    expect(await call("delivery1")).toEqual(["torch/csrc/foo.cpp"]);
    expect(await call("delivery2")).toEqual(["docs/readme.md"]);
    expect(octokit.paginate).toHaveBeenCalledTimes(2);
  });
});

const GHSTACK_HEADER =
  "Stack from [ghstack](https://github.com/ezyang/ghstack/tree/0.17.0) (oldest at bottom):";

function ghstackBody(rows: string[], eol = "\n"): string {
  return ["Summary first.", GHSTACK_HEADER, ...rows, "", "More text."].join(
    eol
  );
}

describe("utils: parseGhstackListing", () => {
  test("splits a listing into the PRs above and below, nearest first", () => {
    const body = ghstackBody(["* #5", "* #4", "* __->__ #3", "* #2", "* #1"]);
    expect(parseGhstackListing(body, 3)).toEqual({
      kind: "stack",
      above: [4, 5],
      below: [2, 1],
    });
  });

  test("reads a CRLF body and dedupes numbers", () => {
    const body = ghstackBody(["* #5", "* #5", "* __->__ #3", "* #1"], "\r\n");
    expect(parseGhstackListing(body, 3)).toEqual({
      kind: "stack",
      above: [5],
      below: [1],
    });
  });

  test("the placeholder listing is pending", () => {
    expect(parseGhstackListing(ghstackBody(["* (to be filled)"]), 3)).toEqual({
      kind: "pending",
    });
  });

  test("a listing that does not mark this PR once is not a stack", () => {
    expect(parseGhstackListing(ghstackBody(["* #4", "* #3"]), 3)).toEqual({
      kind: "none",
    });
    expect(
      parseGhstackListing(ghstackBody(["* #4", "* __->__ #2", "* #3"]), 3)
    ).toEqual({ kind: "none" });
    expect(
      parseGhstackListing(ghstackBody(["* __->__ #3", "* __->__ #3"]), 3)
    ).toEqual({ kind: "none" });
    expect(parseGhstackListing("no listing here", 3)).toEqual({
      kind: "none",
    });
    expect(parseGhstackListing(null, 3)).toEqual({ kind: "none" });
  });

  test("the listing ends at the first line that is not a row", () => {
    const body = ghstackBody([
      "* #4",
      "* __->__ #3",
      "* #2",
      "* #1 trailing text",
      "* #0",
      "* #9",
    ]);
    expect(parseGhstackListing(body, 3)).toEqual({
      kind: "stack",
      above: [4],
      below: [2],
    });
  });
});

describe("utils: getOpenStackPrs", () => {
  const octokit = utils.testOctokit();
  const owner = "pytorch";
  const repo = "pytorch";

  function prNode(
    number: number,
    options: {
      state?: string;
      user?: string;
      isDraft?: boolean;
      isCrossRepository?: boolean;
      files?: string[];
      changedFiles?: number;
      labels?: string[];
      headRefName?: string;
    } = {}
  ) {
    const files = options.files ?? [`torch/f${number}.py`];
    return {
      number,
      state: options.state ?? "OPEN",
      isDraft: options.isDraft ?? false,
      isCrossRepository: options.isCrossRepository ?? false,
      headRefName:
        options.headRefName ?? `gh/${options.user ?? "alice"}/${number}/head`,
      labels: { nodes: (options.labels ?? []).map((name) => ({ name })) },
      changedFiles: options.changedFiles ?? files.length,
      files: { nodes: files.map((path) => ({ path })) },
    };
  }

  function mockPrs(data: any) {
    return nock("https://api.github.com")
      .post("/graphql", (body) => body.query.includes("StackPrFields"))
      .reply(200, { data });
  }

  // behindBy per compared pair, in order; null is a head ref that is missing.
  function mockCompare(behindBy: (number | null)[], sent: any = {}) {
    const repository: any = {};
    const errors: any[] = [];
    behindBy.forEach((b, i) => {
      repository[`c${i}`] = {
        compare:
          b === null
            ? null
            : { behindBy: b, status: b === 0 ? "AHEAD" : "DIVERGED" },
      };
      if (b === null) {
        errors.push({ type: "NOT_FOUND", path: ["repository", `c${i}`] });
      }
    });
    return nock("https://api.github.com")
      .post("/graphql", (body) => {
        if (!body.query.includes("compare(")) {
          return false;
        }
        Object.assign(sent, body.variables);
        return true;
      })
      .reply(
        200,
        errors.length
          ? { data: { repository }, errors }
          : { data: { repository } }
      );
  }

  const subject = (rows: string[], extra: any = {}) => ({
    number: 3,
    body: ghstackBody(rows),
    headRef: "gh/alice/3/head",
    isCrossRepository: false,
    ...extra,
  });

  afterEach(() => {
    nock.cleanAll();
  });

  test("ghstack above: keeps open same-repo PRs of the same user that contain the PR", async () => {
    let sentVariables: any;
    const prsScope = nock("https://api.github.com")
      .post("/graphql", (body) => {
        if (!body.query.includes("StackPrFields")) {
          return false;
        }
        sentVariables = body.variables;
        return true;
      })
      .reply(200, {
        data: {
          repository: {
            pr0: prNode(4, { labels: ["ciflow/inductor"] }),
            pr1: prNode(5, { state: "CLOSED" }),
            pr2: prNode(6, { user: "bob" }),
            pr3: prNode(7, { isDraft: true }),
            pr4: prNode(8, { isCrossRepository: true }),
          },
        },
      });
    const compared: any = {};
    const compareScope = mockCompare([0, 0], compared);
    const result = await getOpenStackPrs(
      octokit,
      owner,
      repo,
      subject(["* #8", "* #7", "* #6", "* #5", "* #4", "* __->__ #3"]),
      "above"
    );
    prsScope.done();
    compareScope.done();
    expect(sentVariables).toMatchObject({ n0: 4, n1: 5, n2: 6, n3: 7, n4: 8 });
    expect(compared).toMatchObject({
      b0: "refs/heads/gh/alice/3/orig",
      h0: "refs/heads/gh/alice/4/orig",
      b1: "refs/heads/gh/alice/3/orig",
      h1: "refs/heads/gh/alice/7/orig",
    });
    expect(compared.b2).toBeUndefined();
    expect(result).toEqual({
      kind: "stack",
      prs: [
        {
          number: 4,
          isDraft: false,
          labels: ["ciflow/inductor"],
          files: ["torch/f4.py"],
        },
        { number: 7, isDraft: true, labels: [], files: ["torch/f7.py"] },
      ],
    });
  });

  test("an upper PR whose orig does not contain the PR, or is missing, is not returned", async () => {
    const prsScope = mockPrs({
      repository: { pr0: prNode(4), pr1: prNode(5), pr2: prNode(6) },
    });
    const compareScope = mockCompare([1, null, 0]);
    const result = await getOpenStackPrs(
      octokit,
      owner,
      repo,
      subject(["* #6", "* #5", "* #4", "* __->__ #3"]),
      "above"
    );
    prsScope.done();
    compareScope.done();
    expect(result.kind === "stack" && result.prs.map((p) => p.number)).toEqual([
      6,
    ]);
  });

  test("ghstack with a placeholder listing is pending, with no query", async () => {
    const result = await getOpenStackPrs(
      octokit,
      owner,
      repo,
      subject(["* (to be filled)"]),
      "above"
    );
    expect(result).toEqual({ kind: "pending" });
  });

  test("a fork PR with a ghstack-looking head ref is not stacked, with no query", async () => {
    const result = await getOpenStackPrs(
      octokit,
      owner,
      repo,
      subject(["* #4", "* __->__ #3"], { isCrossRepository: true }),
      "above"
    );
    expect(result).toEqual({ kind: "none" });
  });

  test("a PR that is neither ghstack nor native-stacked is not a stack", async () => {
    const result = await getOpenStackPrs(
      octokit,
      owner,
      repo,
      subject(["* #4", "* __->__ #3"], { headRef: "my-feature" }),
      "above"
    );
    expect(result).toEqual({ kind: "none" });
  });

  test("ghstack below: compares the lower orig against the PR's and falls back to REST for many files", async () => {
    const many = Array.from({ length: 100 }, (_, i) => `torch/a${i}.py`);
    const prsScope = mockPrs({
      repository: { pr0: prNode(2, { files: many, changedFiles: 101 }) },
    });
    const compared: any = {};
    const compareScope = mockCompare([0], compared);
    const filesScope = nock("https://api.github.com")
      .get("/repos/pytorch/pytorch/pulls/2/files?per_page=100")
      .reply(
        200,
        [...many, "torch/a100.py"].map((filename) => ({ filename }))
      );
    const result = await getOpenStackPrs(
      octokit,
      owner,
      repo,
      subject(["* __->__ #3", "* #2"]),
      "below"
    );
    prsScope.done();
    compareScope.done();
    filesScope.done();
    expect(compared).toMatchObject({
      b0: "refs/heads/gh/alice/2/orig",
      h0: "refs/heads/gh/alice/3/orig",
    });
    expect(result.kind === "stack" && result.prs[0].files).toHaveLength(101);
  });

  test("native above: keeps the open same-repo entries above that contain the PR", async () => {
    const prsScope = nock("https://api.github.com")
      .post("/graphql", (body) => body.variables.number === 11)
      .reply(200, {
        data: {
          repository: {
            pullRequest: {
              stack: {
                entries: {
                  totalCount: 5,
                  pageInfo: { hasNextPage: false },
                  nodes: [
                    {
                      position: 4,
                      pullRequest: prNode(14, { headRefName: "feature-d" }),
                    },
                    {
                      position: 1,
                      pullRequest: prNode(10, { headRefName: "feature-a" }),
                    },
                    {
                      position: 2,
                      pullRequest: prNode(11, { headRefName: "feature-b" }),
                    },
                    {
                      position: 3,
                      pullRequest: prNode(13, { state: "MERGED" }),
                    },
                    {
                      position: 5,
                      pullRequest: prNode(15, { isCrossRepository: true }),
                    },
                  ],
                },
              },
            },
          },
        },
      });
    const compared: any = {};
    const compareScope = mockCompare([0], compared);
    const result = await getOpenStackPrs(
      octokit,
      owner,
      repo,
      {
        number: 11,
        body: "",
        headRef: "feature-b",
        isCrossRepository: false,
        stack: { position: 2, size: 5 },
      },
      "above"
    );
    prsScope.done();
    compareScope.done();
    expect(compared).toMatchObject({
      b0: "refs/heads/feature-b",
      h0: "refs/heads/feature-d",
    });
    expect(result.kind === "stack" && result.prs.map((p) => p.number)).toEqual([
      14,
    ]);
  });

  test("native: an incomplete page of entries is an error", async () => {
    nock("https://api.github.com")
      .post("/graphql")
      .reply(200, {
        data: {
          repository: {
            pullRequest: {
              stack: {
                entries: {
                  totalCount: 3,
                  pageInfo: { hasNextPage: false },
                  nodes: [
                    { position: 1, pullRequest: prNode(10) },
                    { position: 2, pullRequest: null },
                  ],
                },
              },
            },
          },
        },
      });
    await expect(
      getOpenStackPrs(
        octokit,
        owner,
        repo,
        {
          number: 10,
          body: "",
          headRef: "feature-a",
          isCrossRepository: false,
          stack: { position: 1, size: 3 },
        },
        "above"
      )
    ).rejects.toThrow("could not read all 3 PRs");
  });

  test("native top of the stack has nothing above, with no query", async () => {
    const result = await getOpenStackPrs(
      octokit,
      owner,
      repo,
      {
        number: 14,
        body: "",
        headRef: "feature-d",
        isCrossRepository: false,
        stack: { position: 4, size: 4 },
      },
      "above"
    );
    expect(result).toEqual({ kind: "stack", prs: [] });
  });
});
