import * as clickhouse from "lib/clickhouse";
import fetchPR from "lib/fetchPR";
import { Octokit } from "octokit";

function makeOctokit(opts: { getResult?: any; paginateResult?: any[] }) {
  const get = jest.fn().mockResolvedValue(opts.getResult ?? { data: {} });
  // listCommits is only passed to paginate as an endpoint reference; the fake
  // paginate ignores it, so it is never actually invoked by fetchPR.
  const listCommits = jest.fn();
  const paginate = jest.fn().mockResolvedValue(opts.paginateResult ?? []);
  const octokit = {
    rest: { pulls: { get, listCommits } },
    paginate,
  } as unknown as Octokit;
  return { octokit, get, listCommits, paginate };
}

describe("fetchPR", () => {
  let queryClickhouse: jest.SpyInstance;
  let queryClickhouseSaved: jest.SpyInstance;

  beforeEach(() => {
    queryClickhouse = jest.spyOn(clickhouse, "queryClickhouse");
    queryClickhouseSaved = jest.spyOn(clickhouse, "queryClickhouseSaved");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("(a) ClickHouse hit uses CH title/body and does not call pulls.get", async () => {
    queryClickhouse.mockResolvedValue([
      { title: "CH title", body: "CH body", head_sha: "shaA" },
    ]);
    queryClickhouseSaved.mockResolvedValue([
      { sha: "shaA", message: "commit a\nsecond line" },
    ]);
    const { octokit, get, paginate } = makeOctokit({});

    const result = await fetchPR("pytorch", "pytorch", "123", octokit);

    expect(result).toEqual({
      title: "CH title",
      body: "CH body",
      shas: [{ sha: "shaA", title: "commit a" }],
    });
    expect(get).not.toHaveBeenCalled();
    // CH already has the tip (newest sha === head sha), so no GitHub commits call.
    expect(paginate).not.toHaveBeenCalled();
    // Title/body query is pinned by the exact html_url + PR number.
    expect(queryClickhouse.mock.calls[0][1]).toEqual({
      prNumber: "123",
      htmlUrl: "https://github.com/pytorch/pytorch/pull/123",
    });
  });

  test("(b) ClickHouse miss (empty) falls back to pulls.get", async () => {
    queryClickhouse.mockResolvedValue([]);
    queryClickhouseSaved.mockResolvedValue([]);
    const { octokit, get, paginate } = makeOctokit({
      getResult: {
        data: { title: "GH title", body: "GH body", head: { sha: "shaGH" } },
      },
      paginateResult: [{ sha: "shaGH", commit: { message: "gh commit" } }],
    });

    const result = await fetchPR("pytorch", "pytorch", "123", octokit);

    expect(result).toEqual({
      title: "GH title",
      body: "GH body",
      shas: [{ sha: "shaGH", title: "gh commit" }],
    });
    expect(get).toHaveBeenCalledTimes(1);
    // No CH commits at all, so GitHub commits are fetched.
    expect(paginate).toHaveBeenCalledTimes(1);
  });

  test("(c) ClickHouse error falls back to GitHub without crashing", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    queryClickhouse.mockRejectedValue(new Error("clickhouse down"));
    queryClickhouseSaved.mockRejectedValue(new Error("clickhouse down"));
    const { octokit, get, paginate } = makeOctokit({
      getResult: {
        data: { title: "GH title", body: "GH body", head: { sha: "shaGH" } },
      },
      paginateResult: [{ sha: "shaGH", commit: { message: "gh commit" } }],
    });

    const result = await fetchPR("pytorch", "pytorch", "123", octokit);

    expect(result).toEqual({
      title: "GH title",
      body: "GH body",
      shas: [{ sha: "shaGH", title: "gh commit" }],
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(paginate).toHaveBeenCalledTimes(1);
    // Both failing reads are logged with detail, not silently swallowed.
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("(d) newest CH sha === knownHeadSha skips listCommits", async () => {
    queryClickhouse.mockResolvedValue([
      { title: "CH title", body: "CH body", head_sha: "ignored" },
    ]);
    queryClickhouseSaved.mockResolvedValue([
      { sha: "old", message: "m1" },
      { sha: "shaHead", message: "tip" },
    ]);
    const { octokit, get, paginate } = makeOctokit({});

    const result = await fetchPR(
      "pytorch",
      "pytorch",
      "123",
      octokit,
      "shaHead"
    );

    expect(result).toEqual({
      title: "CH title",
      body: "CH body",
      shas: [
        { sha: "old", title: "m1" },
        { sha: "shaHead", title: "tip" },
      ],
    });
    expect(get).not.toHaveBeenCalled();
    expect(paginate).not.toHaveBeenCalled();
  });

  test("(e) newest CH sha !== knownHeadSha calls listCommits and reconciles the tip", async () => {
    queryClickhouse.mockResolvedValue([
      { title: "CH title", body: "CH body", head_sha: "ignored" },
    ]);
    queryClickhouseSaved.mockResolvedValue([
      { sha: "old1", message: "m1" },
      { sha: "old2", message: "m2" },
    ]);
    const { octokit, get, paginate } = makeOctokit({
      paginateResult: [
        { sha: "old1", commit: { message: "m1" } },
        { sha: "old2", commit: { message: "m2" } },
        { sha: "shaHead", commit: { message: "tip msg" } },
      ],
    });

    const result = await fetchPR(
      "pytorch",
      "pytorch",
      "123",
      octokit,
      "shaHead"
    );

    expect(paginate).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
    expect(result.title).toBe("CH title");
    expect(result.body).toBe("CH body");
    expect(result.shas).toEqual([
      { sha: "old1", title: "m1" },
      { sha: "old2", title: "m2" },
      { sha: "shaHead", title: "tip msg" },
    ]);
  });
});
