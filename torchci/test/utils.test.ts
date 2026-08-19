import {
  clearFilesChangedCache,
  getFilesChangedByPrCached,
  hasApprovedPullRuns,
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
      getFilesChangedByPrCached(octokit, "pytorch", "pytorch", 1, sha);

    expect(await call("sha1")).toEqual(["a.py", "b.py"]);
    expect(await call("sha1")).toEqual(["a.py", "b.py"]);
    expect(octokit.paginate).toHaveBeenCalledTimes(1);

    await call("sha2");
    expect(octokit.paginate).toHaveBeenCalledTimes(2);

    clearFilesChangedCache();
    await call("sha1");
    expect(octokit.paginate).toHaveBeenCalledTimes(3);
  });
});
