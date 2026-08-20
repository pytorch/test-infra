import * as clickhouse from "lib/clickhouse";
import fetchHud, { commitDataFromPushRow } from "lib/fetchHud";
import * as github from "lib/github";
import { formatHudUrlForFetch, HudParams, packHudParams } from "lib/types";
import { Octokit } from "octokit";

function makeParams(overrides: Partial<HudParams> = {}): HudParams {
  return {
    repoOwner: "pytorch",
    repoName: "pytorch",
    branch: "main",
    page: 1,
    per_page: 2,
    filter_reruns: false,
    filter_unstable: false,
    ...overrides,
  };
}

// A CH hud_commits row as returned by the saved query (subcolumns unnested).
const chRows = [
  {
    sha: "sha1",
    message:
      "Title one\n\nbody\n\nPull Request resolved: https://github.com/pytorch/pytorch/pull/111",
    url: "https://github.com/pytorch/pytorch/commit/sha1",
    timestamp: "2026-01-02T00:00:01Z",
    author_username: "alice",
    author_name: "Alice A",
  },
  {
    sha: "sha2",
    message: "Title two",
    url: "https://github.com/pytorch/pytorch/commit/sha2",
    timestamp: "2026-01-02T00:00:00Z",
    author_username: "",
    author_name: "Bob B",
  },
];

// A GitHub listCommits payload element in the shape commitDataFromResponse reads.
const ghCommit = {
  sha: "ghsha",
  html_url: "https://github.com/pytorch/pytorch/commit/ghsha",
  author: { login: "ghuser", html_url: "https://github.com/ghuser" },
  commit: {
    message: "GH title\n\nGH body",
    author: { name: "GH Name" },
    committer: { date: "2026-02-02T00:00:00Z" },
  },
};

function mockClickhouse(opts: {
  hudCommits?: any[];
  hudCommitsReject?: boolean;
  forcedMerge?: any[];
  autorevert?: any[];
  hudQuery?: any[];
}) {
  return jest
    .spyOn(clickhouse, "queryClickhouseSaved")
    .mockImplementation((queryName: string) => {
      switch (queryName) {
        case "hud_commits":
          if (opts.hudCommitsReject) {
            return Promise.reject(new Error("clickhouse down"));
          }
          return Promise.resolve(opts.hudCommits ?? []);
        case "hud_query":
          return Promise.resolve(opts.hudQuery ?? []);
        case "filter_forced_merge_pr":
          return Promise.resolve(opts.forcedMerge ?? []);
        case "autorevert_commits":
          return Promise.resolve(opts.autorevert ?? []);
        default:
          return Promise.resolve([]);
      }
    });
}

function mockOctokit(listCommitsData: any[]) {
  const listCommits = jest.fn().mockResolvedValue({ data: listCommitsData });
  const octokit = {
    rest: { repos: { listCommits } },
  } as unknown as Octokit;
  const getOctokit = jest
    .spyOn(github, "getOctokit")
    .mockResolvedValue(octokit);
  return { getOctokit, listCommits };
}

describe("fetchHud", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("(a) covered branch page 1 sources commits from ClickHouse, not GitHub", async () => {
    mockClickhouse({
      hudCommits: chRows,
      forcedMerge: [{ merge_commit_sha: "sha1", force_merge_with_failures: 1 }],
      autorevert: [
        {
          commit_sha: "sha2",
          all_workflows: [["trunk"]],
          all_source_signal_keys: [["sig1"]],
        },
      ],
    });
    const { listCommits } = mockOctokit([]);

    const { shaGrid } = await fetchHud(makeParams());

    // The full page came from ClickHouse, so GitHub is never touched.
    expect(listCommits).not.toHaveBeenCalled();
    expect(shaGrid.map((r) => r.sha)).toEqual(["sha1", "sha2"]);

    // sha1: username present -> author + authorUrl from the login; PR parsed;
    // forced-merge flags applied from filter_forced_merge_pr.
    expect(shaGrid[0]).toMatchObject({
      sha: "sha1",
      author: "alice",
      authorUrl: "https://github.com/alice",
      commitTitle: "Title one",
      commitUrl: "https://github.com/pytorch/pytorch/commit/sha1",
      time: "2026-01-02T00:00:01Z",
      prNum: 111,
      isForcedMerge: true,
      isForcedMergeWithFailures: true,
      isAutoreverted: false,
    });

    // sha2: empty username -> git name and null URL; no PR; autorevert applied.
    expect(shaGrid[1]).toMatchObject({
      sha: "sha2",
      author: "Bob B",
      authorUrl: null,
      commitTitle: "Title two",
      prNum: null,
      isForcedMerge: false,
      isAutoreverted: true,
      autorevertWorkflows: ["trunk"],
      autorevertSignals: ["sig1"],
    });
  });

  test("(b1) a raw-sha branch skips ClickHouse and uses GitHub", async () => {
    const saved = mockClickhouse({ hudCommits: chRows });
    const { listCommits } = mockOctokit([ghCommit]);

    const { shaGrid } = await fetchHud(makeParams({ branch: "a".repeat(40) }));

    expect(listCommits).toHaveBeenCalledTimes(1);
    // hud_commits is never queried for a raw sha; the job/flag queries still run.
    const queriedNames = saved.mock.calls.map((c) => c[0]);
    expect(queriedNames).not.toContain("hud_commits");
    expect(shaGrid.map((r) => r.sha)).toEqual(["ghsha"]);
    expect(shaGrid[0]).toMatchObject({
      author: "ghuser",
      authorUrl: "https://github.com/ghuser",
      commitTitle: "GH title",
    });
  });

  test("(b2) an empty ClickHouse result falls back to GitHub", async () => {
    mockClickhouse({ hudCommits: [] });
    const { listCommits } = mockOctokit([ghCommit]);

    const { shaGrid } = await fetchHud(makeParams());

    expect(listCommits).toHaveBeenCalledTimes(1);
    expect(shaGrid.map((r) => r.sha)).toEqual(["ghsha"]);
  });

  test("(c) a ClickHouse error falls back to GitHub without crashing", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockClickhouse({ hudCommitsReject: true });
    const { listCommits } = mockOctokit([ghCommit]);

    const { shaGrid } = await fetchHud(makeParams());

    expect(listCommits).toHaveBeenCalledTimes(1);
    expect(shaGrid.map((r) => r.sha)).toEqual(["ghsha"]);
    // The failing read is logged with detail, not silently swallowed.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("(d) fewer ClickHouse rows than a page falls back to GitHub", async () => {
    // per_page is 2 but ClickHouse only has 1 row (deep page / ingest lag).
    mockClickhouse({ hudCommits: [chRows[0]] });
    const { listCommits } = mockOctokit([ghCommit]);

    const { shaGrid } = await fetchHud(makeParams());

    expect(listCommits).toHaveBeenCalledTimes(1);
    expect(shaGrid.map((r) => r.sha)).toEqual(["ghsha"]);
  });

  test("(e) requireLatestCommit skips ClickHouse and uses GitHub", async () => {
    // ClickHouse returns a full page here, so the count-only guard would accept
    // it and never reach GitHub. Only the explicit flag forces the authoritative
    // read the caller asked for.
    const saved = mockClickhouse({ hudCommits: [chRows[0]] });
    const { listCommits } = mockOctokit([ghCommit]);

    const { shaGrid } = await fetchHud(
      makeParams({ per_page: 1, requireLatestCommit: true })
    );

    expect(listCommits).toHaveBeenCalledTimes(1);
    const queriedNames = saved.mock.calls.map((c) => c[0]);
    expect(queriedNames).not.toContain("hud_commits");
    expect(shaGrid.map((r) => r.sha)).toEqual(["ghsha"]);
  });

  test("(f) requireLatestCommit survives the client fetch URL round trip", () => {
    // The flag is set on the client and consumed on the server, so a mismatch
    // across that hop would disable (e) in production with every test still green.
    const url = formatHudUrlForFetch(
      "api/hud",
      makeParams({ per_page: 1, requireLatestCommit: true })
    );
    const query = Object.fromEntries(new URL(url, "https://hud").searchParams);
    expect(packHudParams(query).requireLatestCommit).toBe(true);

    // The grid request shares the same builder and must not opt in.
    const gridUrl = formatHudUrlForFetch("api/hud", makeParams());
    expect(gridUrl).not.toContain("requireLatestCommit");
    const gridQuery = Object.fromEntries(
      new URL(gridUrl, "https://hud").searchParams
    );
    expect(packHudParams(gridQuery).requireLatestCommit).toBe(false);
  });
});

// One logical commit expressed in both source shapes, so a single fixture drives
// both mappers and neither can drift without the other noticing.
function bothShapesOf(opts: {
  sha: string;
  message: string;
  timestamp: string;
  authorLogin: string;
  authorName: string;
}) {
  const commitUrl = `https://github.com/pytorch/pytorch/commit/${opts.sha}`;
  return {
    // hud_commits/query.sql renders timestamp with
    // formatDateTime(ts, '%Y-%m-%dT%H:%i:%SZ', 'UTC'), which is byte-identical to
    // the ISO-8601 Z string GitHub puts in commit.committer.date. It stores
    // author.username as "" rather than null for an unresolved GitHub user.
    chRow: {
      sha: opts.sha,
      message: opts.message,
      url: commitUrl,
      timestamp: opts.timestamp,
      author_username: opts.authorLogin,
      author_name: opts.authorName,
    },
    ghResponse: {
      sha: opts.sha,
      html_url: commitUrl,
      author:
        opts.authorLogin !== ""
          ? {
              login: opts.authorLogin,
              html_url: `https://github.com/${opts.authorLogin}`,
            }
          : null,
      commit: {
        message: opts.message,
        author: { name: opts.authorName },
        committer: { date: opts.timestamp },
      },
    },
  };
}

describe("commit mapping equivalence", () => {
  const sha = "9f2e1c4b7a05d38e6c1b0f4a2d7e8c395b6a1d02";
  const commitUrl = `https://github.com/pytorch/pytorch/commit/${sha}`;
  const timestamp = "2026-08-19T14:32:07Z";

  test("a resolved author maps identically from ClickHouse and GitHub", () => {
    const message = [
      "Fix the thing that broke",
      "",
      "A body spanning several lines, so commitTitle and commitMessageBody are",
      "actually distinguishable.",
      "",
      "Pull Request resolved: https://github.com/pytorch/pytorch/pull/145678",
      "Differential Revision: D65432109",
    ].join("\n");
    const { chRow, ghResponse } = bothShapesOf({
      sha,
      message,
      timestamp,
      authorLogin: "alice",
      authorName: "Alice Anderson",
    });

    const fromCh = commitDataFromPushRow(chRow);

    expect(fromCh).toEqual(github.commitDataFromResponse(ghResponse));
    // Also spelled out: a field both mappers dropped would satisfy the
    // comparison above while never reaching the UI from either source.
    expect(fromCh).toEqual({
      sha,
      time: timestamp,
      author: "alice",
      authorUrl: "https://github.com/alice",
      commitUrl,
      commitTitle: "Fix the thing that broke",
      commitMessageBody: message,
      prNum: 145678,
      diffNum: "D65432109",
    });
  });

  test("an unresolved author falls back to the git name on both paths", () => {
    const message = [
      "Bump the pinned toolchain",
      "",
      "Landed without a PR trailer, so prNum and diffNum stay null.",
    ].join("\n");
    const { chRow, ghResponse } = bothShapesOf({
      sha,
      message,
      timestamp,
      authorLogin: "",
      authorName: "Alice Anderson",
    });

    const fromCh = commitDataFromPushRow(chRow);

    expect(fromCh).toEqual(github.commitDataFromResponse(ghResponse));
    expect(fromCh).toEqual({
      sha,
      time: timestamp,
      author: "Alice Anderson",
      authorUrl: null,
      commitUrl,
      commitTitle: "Bump the pinned toolchain",
      commitMessageBody: message,
      prNum: null,
      diffNum: null,
    });
  });
});
