import { GET } from "app/api/tests/commit/[sha]/summary/route";
import { parseCommitSummaryParams } from "lib/api/tests/commit/summary/parameters";
import {
  buildCommitInfoQuery,
  buildCommitNeighboursQuery,
  buildCommitPullRequestByHeadQuery,
  buildCommitPullRequestQuery,
  buildCommitTestCountsQuery,
} from "lib/api/tests/commit/summary/query";
import { getCommitSummary } from "lib/api/tests/commit/summary/summary";
import { CommitSummarySchema } from "lib/api/tests/commit/summary/types";
import * as clickhouse from "lib/clickhouse";
import { BUNDLE_STATUSES } from "lib/runOutcomes";
import { callRoute } from "../../../routes";

jest.mock("lib/api/auth", () => ({
  requireGithubWriteAccess: (handler: unknown) => handler,
}));

const SHA = "ce6ff46d8ca967ef333ba9b804e081f26b432796";
const REPO = "pytorch/pytorch";
const ROUTE = "/api/tests/commit/{sha}/summary";
const COMMITTED_AT_MS = Date.parse("2026-10-30T12:09:17.000Z");

function infoRow(overrides: Record<string, unknown> = {}) {
  return {
    workflow_runs: 281,
    workflow_message:
      "dynamo: Handle symbolic truthiness of user-defined objects in `not` (#202376)\n\nA long body.",
    workflow_author_name: "Hameer Abbasi",
    workflow_committed_at_ms: COMMITTED_AT_MS,
    push_branches: ["main"],
    pull_requests: [],
    pull_request_branch: "",
    pushes: 1,
    author_login: "hameerabbasi",
    push_message: "ignored while workflow runs exist",
    push_author_name: "ignored",
    push_committed_at_ms: 0,
    refs: ["refs/heads/main"],
    ...overrides,
  };
}

// The rollup row (category '') and one row per worst result, as the counts
// query returns them for ce6ff46.
function countsRows() {
  const zeroes = Object.fromEntries(
    BUNDLE_STATUSES.flatMap((status) => [
      [`${status}_tests`, 0],
      [`${status}_distinct_jobs`, 0],
      [`${status}_bundles`, 0],
    ])
  );
  const row = (
    category: string,
    tests: number,
    jobs: number,
    statuses: Record<string, [number, number, number]>
  ) => ({
    ...zeroes,
    category,
    tests,
    jobs,
    ...Object.fromEntries(
      Object.entries(statuses).flatMap(([status, [tests, jobs, bundles]]) => [
        [`${status}_tests`, tests],
        [`${status}_distinct_jobs`, jobs],
        [`${status}_bundles`, bundles],
      ])
    ),
    any_jobs: jobs,
    first_started_at: "2026-10-30T12:22:39.421Z",
    last_ended_at: "2026-10-30T16:45:00.825Z",
  });
  return [
    row("failed", 4, 5, { failed: [4, 5, 5], passed: [4, 29, 35] }),
    row("timed_out", 8, 4, { timed_out: [8, 4, 8] }),
    row("flaky", 68, 46, { flaky: [68, 46, 87] }),
    row("passed", 529412, 333, { passed: [529412, 333, 4721101] }),
    row("xfailed", 10270, 284, { xfailed: [10270, 284, 80366] }),
    row("skipped", 133001, 326, { skipped: [133001, 326, 1573693] }),
    row("", 672763, 333, {
      failed: [4, 5, 5],
      timed_out: [8, 4, 8],
      flaky: [68, 46, 87],
      passed: [529489, 333, 4721574],
      xfailed: [10443, 290, 81000],
      skipped: [596441, 326, 4375055],
    }),
  ];
}

function answer(
  queryClickhouse: jest.SpyInstance,
  answers: {
    info?: Record<string, unknown>[];
    counts?: Record<string, unknown>[];
    pullRequest?: Record<string, unknown>[];
    pullRequestByHead?: Record<string, unknown>[];
    neighbours?: Record<string, unknown>[];
  }
) {
  queryClickhouse.mockImplementation(async (_sql, _params, queryId) => {
    switch (queryId) {
      case "api_commit_summary_info":
        return answers.info ?? [infoRow()];
      case "api_commit_summary_counts":
        return answers.counts ?? countsRows();
      case "api_commit_summary_pull_request":
        return (
          answers.pullRequest ?? [
            {
              title:
                "dynamo: Handle symbolic truthiness of user-defined objects in `not`",
              html_url: "https://github.com/pytorch/pytorch/pull/202376",
            },
          ]
        );
      case "api_commit_summary_pull_request_by_head":
        // No pull request record has named the commit as its head.
        return answers.pullRequestByHead ?? [];
      case "api_commit_summary_neighbours":
        return (
          answers.neighbours ?? [
            { direction: "newer", neighbour: "6d587b8".padEnd(40, "0") },
            { direction: "older", neighbour: "c8d39cb".padEnd(40, "0") },
          ]
        );
      default:
        throw new Error(`unexpected query ${queryId}`);
    }
  });
}

describe("GET /api/tests/commit/{sha}/summary", () => {
  let queryClickhouse: jest.SpyInstance;
  beforeEach(() => {
    queryClickhouse = jest.spyOn(clickhouse, "queryClickhouse");
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("summarizes a commit on main: the commit, its pull request, its neighbours and every count", async () => {
    answer(queryClickhouse, {});
    const res = await callRoute(GET, ROUTE, {
      sha: SHA.toUpperCase(),
      repo: REPO,
    });
    expect(res.status).toBe(200);
    expect(CommitSummarySchema.parse(res.body)).toEqual(res.body);
    expect(res.body.commit).toEqual({
      sha: SHA,
      url: `https://github.com/pytorch/pytorch/commit/${SHA}`,
      title:
        "dynamo: Handle symbolic truthiness of user-defined objects in `not` (#202376)",
      author: { name: "Hameer Abbasi", login: "hameerabbasi" },
      committed_at: "2026-10-30T12:09:17.000Z",
      branch: "main",
      pull_request_head: false,
      pull_request: {
        number: 202376,
        url: "https://github.com/pytorch/pytorch/pull/202376",
        title:
          "dynamo: Handle symbolic truthiness of user-defined objects in `not`",
      },
      newer_sha: "6d587b8".padEnd(40, "0"),
      older_sha: "c8d39cb".padEnd(40, "0"),
    });
    // The runs are every status's bundles, which add up since a bundle has
    // one status; the same figure as the runs endpoint's stats.total.
    expect(res.body.counts.total).toEqual({
      tests: 672763,
      jobs: 333,
      runs: 9177729,
    });
    expect(res.body.counts.by_worst_status).toEqual({
      failed: { tests: 4, jobs: 5 },
      timed_out: { tests: 8, jobs: 4 },
      flaky: { tests: 68, jobs: 46 },
      passed: { tests: 529412, jobs: 333 },
      other: { tests: 0, jobs: 0 },
      xfailed: { tests: 10270, jobs: 284 },
      skipped: { tests: 133001, jobs: 326 },
    });
    // The seven add up to the total.
    expect(
      Object.values<{ tests: number }>(res.body.counts.by_worst_status).reduce(
        (sum, counts) => sum + counts.tests,
        0
      )
    ).toBe(672763);
    expect(res.body.counts.by_status.flaky).toEqual({
      tests: 68,
      jobs: 46,
      runs: 87,
    });
    expect(res.body.counts.by_status.passed).toEqual({
      tests: 529489,
      jobs: 333,
      runs: 4721574,
    });
    expect(res.body.first_started_at).toBe("2026-10-30T12:22:39.421Z");
    expect(res.body.last_ended_at).toBe("2026-10-30T16:45:00.825Z");
    expect(
      Date.now() - Date.parse(res.body.retention_starts_at)
    ).toBeGreaterThan(13 * 24 * 60 * 60 * 1000);
    expect(res.body.hud_url).toBe(
      `https://hud.pytorch.org/tests/pytorch/pytorch/commit/${SHA}`
    );
    expect(res.body.query_duration_ms).toBeGreaterThanOrEqual(0);
    // The pull request is the title's, looked up by number in the
    // repository; the neighbours are the branch's.
    const calls = queryClickhouse.mock.calls.map((call) => [call[2], call[1]]);
    expect(calls).toEqual(
      expect.arrayContaining([
        ["api_commit_summary_pull_request", { number: 202376, repo: REPO }],
        [
          "api_commit_summary_neighbours",
          {
            repo: REPO,
            ref: "refs/heads/main",
            committed_at_ms: COMMITTED_AT_MS,
          },
        ],
      ])
    );
  });

  test("a pull request head takes the pull request's title and its head branch, and has no neighbours", async () => {
    answer(queryClickhouse, {
      info: [
        infoRow({
          workflow_message: "WIP commit message (#1)\n",
          push_branches: [],
          pull_requests: [
            [
              202459,
              "https://api.github.com/repos/pytorch/pytorch/pulls/202459",
            ],
          ],
          pull_request_branch: "gh/hameerabbasi/12/head",
          pushes: 0,
          author_login: "",
          refs: [],
        }),
      ],
      pullRequest: [
        {
          title: "Add the thing",
          html_url: "https://github.com/pytorch/pytorch/pull/202459",
        },
      ],
    });
    const summary = await getCommitSummary({ sha: SHA, repo: REPO });
    expect(summary?.commit).toMatchObject({
      title: "Add the thing",
      branch: "gh/hameerabbasi/12/head",
      pull_request_head: true,
      author: { name: "Hameer Abbasi", login: null },
      pull_request: {
        number: 202459,
        url: "https://github.com/pytorch/pytorch/pull/202459",
        title: "Add the thing",
      },
      newer_sha: null,
      older_sha: null,
    });
    expect(queryClickhouse.mock.calls.map((call) => call[2])).not.toContain(
      "api_commit_summary_neighbours"
    );
  });

  // A pull request from a fork: its runs record no pull request (none of the
  // 333 fork heads of 2026-11-02's two days did, their ciflow tag pushes
  // included), its ciflow push is a tag, and its branch has no pushes here.
  const forkRuns = infoRow({
    push_branches: [],
    pull_requests: [],
    pull_request_branch: "fix-the-thing",
    pushes: 1,
    author_login: "",
    refs: ["refs/tags/ciflow/trunk/202500"],
  });
  const forkRecord = {
    number: 202500,
    title: "Fix the thing",
    html_url: "https://github.com/pytorch/pytorch/pull/202500",
    head_branch: "fix-the-thing",
  };

  test("a pull request from a fork is found by its SHA among the pull request records", async () => {
    answer(queryClickhouse, {
      info: [forkRuns],
      pullRequestByHead: [forkRecord],
    });
    const summary = await getCommitSummary({ sha: SHA, repo: REPO });
    expect(summary?.commit).toMatchObject({
      title: "Fix the thing",
      branch: "fix-the-thing",
      pull_request_head: true,
      pull_request: {
        number: 202500,
        url: "https://github.com/pytorch/pytorch/pull/202500",
        title: "Fix the thing",
      },
      newer_sha: null,
      older_sha: null,
    });
    const calls = queryClickhouse.mock.calls.map((call) => [call[2], call[1]]);
    expect(calls).toContainEqual([
      "api_commit_summary_pull_request_by_head",
      { sha: SHA, repo: REPO },
    ]);
    // The lookup by SHA read the record, so it is not read again by number,
    // and a pull request head has no neighbours.
    expect(calls.map(([queryId]) => queryId)).not.toContain(
      "api_commit_summary_pull_request"
    );
    expect(calls.map(([queryId]) => queryId)).not.toContain(
      "api_commit_summary_neighbours"
    );
  });

  test("a commit with push runs on a branch is never looked up as a pull request head by its SHA", async () => {
    answer(queryClickhouse, {});
    await getCommitSummary({ sha: SHA, repo: REPO });
    expect(queryClickhouse.mock.calls.map((call) => call[2])).not.toContain(
      "api_commit_summary_pull_request_by_head"
    );
  });

  test("a ciflow tag push is a pull request head, and a pull request without a retained record keeps the commit's title", async () => {
    answer(queryClickhouse, {
      info: [
        infoRow({
          workflow_message: "Fix it (#77)",
          push_branches: [],
          pull_requests: [
            [77, "https://api.github.com/repos/pytorch/pytorch/pulls/77"],
          ],
          pushes: 1,
          refs: ["refs/tags/ciflow/trunk/77"],
        }),
      ],
      pullRequest: [],
    });
    const summary = await getCommitSummary({ sha: SHA, repo: REPO });
    expect(summary?.commit).toMatchObject({
      title: "Fix it (#77)",
      branch: null,
      pull_request_head: true,
      pull_request: {
        number: 77,
        url: "https://github.com/pytorch/pytorch/pull/77",
        title: null,
      },
    });
  });

  test("a merge bot revert has no pull request of its own", async () => {
    answer(queryClickhouse, {
      info: [
        infoRow({
          workflow_message:
            'Revert "[FSDP2] Add public set_unshard_in_current_stream (#202343)"\n\nThis reverts commit abc.',
          workflow_author_name: "PyTorch MergeBot",
          author_login: "pytorchmergebot",
        }),
      ],
    });
    const summary = await getCommitSummary({ sha: SHA, repo: REPO });
    expect(summary?.commit).toMatchObject({
      title:
        'Revert "[FSDP2] Add public set_unshard_in_current_stream (#202343)"',
      pull_request: null,
      author: { name: "PyTorch MergeBot", login: "pytorchmergebot" },
    });
    expect(queryClickhouse.mock.calls.map((call) => call[2])).not.toContain(
      "api_commit_summary_pull_request"
    );
  });

  test("a commit only pushed, with no workflow run, is described by its push", async () => {
    answer(queryClickhouse, {
      info: [
        infoRow({
          workflow_runs: 0,
          workflow_message: "",
          workflow_author_name: "",
          workflow_committed_at_ms: 0,
          push_branches: [],
          push_message: "Docs only\n\nbody",
          push_author_name: "Doc Writer",
          push_committed_at_ms: COMMITTED_AT_MS,
          refs: ["refs/heads/main"],
        }),
      ],
      counts: [],
    });
    const summary = await getCommitSummary({ sha: SHA, repo: REPO });
    expect(summary?.commit).toMatchObject({
      title: "Docs only",
      branch: "main",
      pull_request_head: false,
      author: { name: "Doc Writer", login: "hameerabbasi" },
      committed_at: "2026-10-30T12:09:17.000Z",
    });
    expect(summary?.counts.total).toEqual({ tests: 0, jobs: 0, runs: 0 });
    expect(summary?.counts.by_status.skipped).toEqual({
      tests: 0,
      jobs: 0,
      runs: 0,
    });
    expect(summary?.first_started_at).toBeNull();
    expect(summary?.last_ended_at).toBeNull();
  });

  test("names main among several branches, else the first by name, whatever order the runs come in", async () => {
    answer(queryClickhouse, {
      info: [infoRow({ push_branches: ["release/2.11", "main"], refs: [] })],
    });
    expect(
      (await getCommitSummary({ sha: SHA, repo: REPO }))?.commit
    ).toMatchObject({ branch: "main", pull_request_head: false });
    answer(queryClickhouse, {
      info: [
        infoRow({
          push_branches: ["release/2.11", "nightly"],
          refs: ["refs/heads/viable/strict"],
        }),
      ],
    });
    expect(
      (await getCommitSummary({ sha: SHA, repo: REPO }))?.commit
    ).toMatchObject({ branch: "nightly" });
    // Without push runs, the push's branch refs.
    answer(queryClickhouse, {
      info: [
        infoRow({
          push_branches: [],
          refs: ["refs/tags/v2.11.0", "refs/heads/release/2.11"],
        }),
      ],
    });
    expect(
      (await getCommitSummary({ sha: SHA, repo: REPO }))?.commit
    ).toMatchObject({ branch: "release/2.11" });
    const neighbourRefs = queryClickhouse.mock.calls
      .filter((call) => call[2] === "api_commit_summary_neighbours")
      .map((call) => call[1].ref);
    expect(neighbourRefs).toEqual([
      "refs/heads/main",
      "refs/heads/nightly",
      "refs/heads/release/2.11",
    ]);
  });

  test("a commit HUD never heard of is 404", async () => {
    answer(queryClickhouse, {
      info: [infoRow({ workflow_runs: 0, pushes: 0 })],
      counts: [],
    });
    const res = await callRoute(GET, ROUTE, { sha: SHA, repo: REPO });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Commit not found", code: "not_found" });
  });

  test("rejects a short SHA, a missing repository and an unknown parameter", async () => {
    for (const query of [
      { sha: "ce6ff46", repo: REPO },
      { sha: SHA },
      { sha: SHA, repo: REPO, outcome: "failed" },
    ]) {
      const res = await callRoute(GET, ROUTE, query);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_parameters");
    }
    expect(queryClickhouse).not.toHaveBeenCalled();
    expect(
      parseCommitSummaryParams({ sha: SHA.toUpperCase(), repo: REPO })
    ).toMatchObject({
      success: true,
      data: { sha: SHA, repo: REPO },
    });
  });

  test("binds the repository and SHA and never inlines them", () => {
    const query = { sha: SHA, repo: REPO };
    for (const built of [
      buildCommitInfoQuery(query),
      buildCommitTestCountsQuery(query),
    ]) {
      expect(built.params).toEqual({ sha: SHA, repo: REPO });
      expect(built.sql).not.toContain(SHA);
      expect(built.sql).not.toContain("pytorch/pytorch");
    }
    // The recorded pull requests whose base repository is the commit's.
    expect(buildCommitInfoQuery(query).sql).toContain(
      "arrayFilter(pull_request -> tupleElement(pull_request, 3) = repository.id, arrayZip(pull_requests.number, pull_requests.url, pull_requests.base.repo.id))"
    );
    // The pushes are read by the push table's timestamp key, which the
    // commit-id view finds, never by a scan of the head commit ids.
    expect(buildCommitInfoQuery(query).sql).toContain(
      "FROM default.push\n        WHERE tupleElement(head_commit, 'timestamp') IN (\n            SELECT timestamp FROM materialized_views.push_by_sha WHERE id = {sha: String}\n        )\n            AND head_commit.id = {sha: String}"
    );
    const pullRequest = buildCommitPullRequestQuery(202376, REPO);
    expect(pullRequest.params).toEqual({ number: 202376, repo: REPO });
    // The table holds every repository's pull requests by number.
    expect(pullRequest.sql).toContain(
      "WHERE number = {number: Int64}\n    AND base.repo.full_name = {repo: String}"
    );
    // By SHA: the numbers the head_sha view holds for the commit, the
    // repository's record of the lowest, with its head branch.
    const byHead = buildCommitPullRequestByHeadQuery(query);
    expect(byHead.params).toEqual({ sha: SHA, repo: REPO });
    expect(byHead.sql).toContain(
      "FROM materialized_views.pr_by_sha\n    WHERE head_sha = {sha: String}"
    );
    expect(byHead.sql).toContain("head.ref AS head_branch");
    expect(byHead.sql).toContain(
      "AND base.repo.full_name = {repo: String}\nORDER BY number ASC, updated_at DESC\nLIMIT 1"
    );
    expect(byHead.sql).not.toContain(SHA);
    const neighbours = buildCommitNeighboursQuery({
      repo: REPO,
      branch: "main",
      committedAtMs: COMMITTED_AT_MS,
    });
    expect(neighbours.params).toEqual({
      repo: REPO,
      ref: "refs/heads/main",
      committed_at_ms: COMMITTED_AT_MS,
    });
    expect(neighbours.sql).toContain("name LIKE '% / test (%'");
    // The candidates are gathered once, into an array scalar; their jobs
    // are found through the job table's head_sha view and read by id, never
    // by a scan of the job table. Each side reads the push table in its
    // key order, the timestamp spelled as the key is, and stops at its
    // twentieth push.
    expect(neighbours.sql).toMatch(
      /^\s*WITH \(\s+SELECT groupArray\(\(direction, sha, committed_at\)\)/
    );
    expect(neighbours.sql).not.toContain("WITH candidates AS");
    expect(neighbours.sql).toContain(
      "FROM materialized_views.workflow_job_by_head_sha\n            WHERE head_sha IN (SELECT tupleElement(candidate, 2) FROM (SELECT arrayJoin(candidates) AS candidate))"
    );
    expect(neighbours.sql).toMatch(
      /FROM default\.workflow_job\s+WHERE id IN \(/
    );
    expect(neighbours.sql).not.toMatch(
      /FROM default\.workflow_job\s+WHERE name/
    );
    expect(neighbours.sql).toContain(
      "AND tupleElement(head_commit, 'timestamp') > fromUnixTimestamp64Milli({committed_at_ms: Int64})\n        ORDER BY tupleElement(head_commit, 'timestamp') ASC"
    );
    expect(neighbours.sql).toContain(
      "AND tupleElement(head_commit, 'timestamp') < fromUnixTimestamp64Milli({committed_at_ms: Int64})\n        ORDER BY tupleElement(head_commit, 'timestamp') DESC"
    );
    expect(neighbours.sql).not.toMatch(
      /(?:<|>|ORDER BY) head_commit\.timestamp/
    );
    // The counts read the commit's jobs as the runs endpoint does, resolve
    // replacements by key, and roll the categories up.
    const counts = buildCommitTestCountsQuery(query).sql;
    expect(counts).toContain("AS matched_job_ids");
    expect(counts).toContain("AS multi_row_keys");
    expect(counts).toContain("GROUP BY category WITH ROLLUP");
    expect(counts).toContain("UNION ALL");
    expect(counts).toContain("FROM ci.runs AS run FINAL");
  });
});
