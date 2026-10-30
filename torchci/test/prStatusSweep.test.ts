import * as drci from "lib/drciUtils";
import {
  DRCI_COMMENT_AUTHOR,
  DRCI_COMMENT_START,
  formDrciComment,
  upsertPrStatusSection,
} from "lib/drciUtils";
import * as searchUtils from "lib/githubSearch";
import * as prStatus from "lib/prStatus";
import { PR_STATUS_START, renderPrStatusSection } from "lib/prStatus";
import { refreshPrStatusComments } from "lib/prStatusSweep";
import nock from "nock";
import { handleScope } from "./common";
import { testOctokit } from "./utils";

nock.disableNetConnect();

const NOW = Date.parse("2026-10-30T16:30:00Z");
const ENTERED = "2026-10-29T16:30:00Z";
const REPO = "pytorch/pytorch";
const CI_RESULTS =
  "## CI results\nPreviously classified CI failures stay here.\n";
const reader = testOctokit();
const writer = testOctokit();
const api = () => nock("https://api.github.com");

function pull(number = 1, overrides = {}) {
  return {
    number,
    state: "open",
    draft: false,
    created_at: "2025-01-01T00:00:00Z",
    labels: [{ name: "ready for review" }],
    user: { login: "author" },
    requested_reviewers: [],
    requested_teams: [],
    ...overrides,
  };
}

function search(items = [pull()]) {
  return api()
    .get("/search/issues")
    .query((params) => {
      expect(params.q).toBe(
        "repo:pytorch/pytorch is:pr is:open " +
          `created:1970-01-01T00:00:00.000Z..${new Date(NOW).toISOString()}`
      );
      return true;
    })
    .reply(200, {
      total_count: items.length,
      items,
      incomplete_results: false,
    });
}

function reads(pr = pull(), reviews: object[] = []) {
  return api()
    .get(`/repos/${REPO}/pulls/${pr.number}`)
    .reply(200, pr)
    .get(`/repos/${REPO}/pulls/${pr.number}/reviews?per_page=100`)
    .reply(200, reviews);
}

function commentRead(number = 1, body?: string) {
  return api()
    .get(`/repos/${REPO}/issues/${number}/comments`)
    .reply(
      200,
      body === undefined
        ? []
        : [{ id: number * 10, user: { login: DRCI_COMMENT_AUTHOR }, body }]
    );
}

const refresh = () =>
  refreshPrStatusComments(reader, writer, "pytorch", "pytorch", NOW);

beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  nock.cleanAll();
});

test("recovers a quiet later phase after dismissal, preserves CI, and leaves identical comments alone", async () => {
  const writerReads = jest.spyOn(writer, "paginate");
  const writerPullReads = jest.spyOn(writer.rest.pulls, "get");
  const writerSearches = jest.spyOn(
    writer.rest.search,
    "issuesAndPullRequests"
  );
  const readerWrites = jest.spyOn(reader.rest.issues, "updateComment");
  const approved = formDrciComment(
    1,
    "pytorch",
    "pytorch",
    CI_RESULTS,
    "",
    renderPrStatusSection({
      labels: ["ready for review"],
      isApproved: true,
      isMergeApproved: true,
      assignedReviewers: [],
    })
  );
  const reviews = [
    {
      user: { login: "maintainer" },
      author_association: "MEMBER",
      state: "DISMISSED",
      submitted_at: ENTERED,
    },
  ];
  let updated = "";
  let scopes = [
    search(),
    reads(pull(), reviews),
    commentRead(1, approved),
    api()
      .patch(`/repos/${REPO}/issues/comments/10`, (body) => {
        updated = body.body;
        expect(updated).toContain("## PR Status: ready for maintainer review");
        expect(updated).not.toContain("## PR Status: Approved");
        expect(updated).toContain(CI_RESULTS);
        expect(updated.match(/## PR Status:/g)).toHaveLength(1);
        return true;
      })
      .reply(200, {}),
  ];
  expect(await refresh()).toEqual({ checked: 1, failed: [] });
  handleScope(scopes);

  scopes = [search(), reads(pull(), reviews), commentRead(1, updated)];
  expect(await refresh()).toEqual({ checked: 1, failed: [] });
  handleScope(scopes);
  expect(writerReads).not.toHaveBeenCalled();
  expect(writerPullReads).not.toHaveBeenCalled();
  expect(writerSearches).not.toHaveBeenCalled();
  expect(readerWrites).not.toHaveBeenCalled();
});

test("creates a missing bot comment with status and helpful links, then reuses it on retry", async () => {
  const pr = pull(1, {
    labels: [{ name: "ready for review" }, { name: "open source" }],
    head: { ref: "feature/fix" },
  });
  let created = "";
  const readerWrites = jest.spyOn(reader.rest.issues, "createComment");
  const scopes = [
    search(),
    reads(pr),
    commentRead(),
    api()
      .post(`/repos/${REPO}/issues/1/comments`, (body) => {
        created = body.body;
        expect(created).toContain(DRCI_COMMENT_START);
        expect(created).toContain("## PR Status: ready for maintainer review");
        expect(created).toContain("https://hud.pytorch.org/pr/1");
        expect(created).toContain("Helpful Links");
        expect(created).toContain("Auto PR Triage runs for this PR");
        expect(created).toContain("branch%3Afeature%2Ffix");
        expect(created).not.toContain("## CI results");
        expect(created).not.toContain("CI passed");
        return true;
      })
      .reply(201, {}),
  ];
  expect(await refresh()).toEqual({ checked: 1, failed: [] });
  handleScope(scopes);
  expect(readerWrites).not.toHaveBeenCalled();

  const retry = [search(), reads(pr), commentRead(1, created)];
  expect(await refresh()).toEqual({ checked: 1, failed: [] });
  handleScope(retry);
});

test("comment creation remains opt-in for existing callers", async () => {
  const scope = commentRead();
  await upsertPrStatusSection(
    writer,
    "pytorch",
    "pytorch",
    1,
    ["ready for review"],
    "author",
    {
      reader,
      state: {
        labels: ["ready for review"],
        isApproved: false,
        assignedReviewers: [],
      },
    }
  );
  handleScope(scope);
});

test("refreshes actual pre-review policy from the single live state read", async () => {
  const pr = pull(1, {
    created_at: ENTERED,
    labels: [{ name: "triaged" }],
    requested_reviewers: [{ login: "alice" }, { login: "bob" }],
  });
  const scopes = [
    search([pr]),
    reads(pr),
    api()
      .get(`/repos/${REPO}/issues/1/timeline?per_page=100`)
      .reply(200, [
        { event: "labeled", label: { name: "triaged" }, created_at: ENTERED },
      ])
      .get(`/repos/${REPO}/issues/1/reactions?per_page=100`)
      .reply(200, [{ content: "+1", user: { login: "alice" } }]),
    commentRead(1, formDrciComment(1, "pytorch", "pytorch", CI_RESULTS)),
    api()
      .patch(`/repos/${REPO}/issues/comments/10`, (body) => {
        expect(body.body).toContain("**Waiting for pre-review:** `bob`.");
        expect(body.body).toContain("**Pre-review accepted:** `alice`.");
        expect(body.body).toContain("2026-11-05 16:30:00 UTC");
        expect(body.body).toContain(CI_RESULTS);
        return true;
      })
      .reply(200, {}),
  ];
  expect(await refresh()).toEqual({ checked: 1, failed: [] });
  handleScope(scopes);
});

test("includes drafts without polling pre-review reactions or timeline", async () => {
  const pr = pull(1, { draft: true, labels: [{ name: "triaged" }] });
  const scopes = [
    search([pr]),
    reads(pr),
    commentRead(),
    api()
      .post(`/repos/${REPO}/issues/1/comments`, (body) => {
        expect(body.body).toContain("## PR Status: draft");
        return true;
      })
      .reply(201, {}),
  ];
  expect(await refresh()).toEqual({ checked: 1, failed: [] });
  handleScope(scopes);
});

test("live label removal removes stale status while preserving CI", async () => {
  const body = formDrciComment(
    1,
    "pytorch",
    "pytorch",
    CI_RESULTS,
    "",
    renderPrStatusSection({
      labels: ["in progress"],
      isApproved: false,
      assignedReviewers: [],
    })
  );
  const scopes = [
    search([pull(1, { labels: [] })]),
    reads(pull(1, { labels: [] })),
    commentRead(1, body),
    api()
      .patch(`/repos/${REPO}/issues/comments/10`, (request) => {
        expect(request.body).not.toContain(PR_STATUS_START);
        expect(request.body).toContain(CI_RESULTS);
        return true;
      })
      .reply(200, {}),
  ];
  expect(await refresh()).toEqual({ checked: 1, failed: [] });
  handleScope(scopes);
});

test("does not create a comment for a PR outside the workflow", async () => {
  const pr = pull(1, { labels: [] });
  const scopes = [search([pr]), reads(pr), commentRead()];
  expect(await refresh()).toEqual({ checked: 1, failed: [] });
  handleScope(scopes);
});

test("a stale search result for a closed PR does not touch comments", async () => {
  const commentReads = jest.spyOn(drci, "getDrciComment");
  const scopes = [search(), reads(pull(1, { state: "closed" }))];
  expect(await refresh()).toEqual({ checked: 1, failed: [] });
  expect(commentReads).not.toHaveBeenCalled();
  handleScope(scopes);
});

test("checks live PR state even when a stale search match has already lost its labels", async () => {
  const commentReads = jest.spyOn(drci, "getDrciComment");
  const scopes = [
    search([pull(1, { labels: [] })]),
    reads(pull(1, { labels: [], state: "closed" })),
  ];
  expect(await refresh()).toEqual({ checked: 1, failed: [] });
  expect(commentReads).not.toHaveBeenCalled();
  handleScope(scopes);
});

test.each(["reviews", "pull"])(
  "preserves status on a failed %s read and still refreshes other PRs",
  async (failedRead) => {
    const updates = jest.spyOn(writer.rest.issues, "updateComment");
    const scopes = [
      search([pull(1), pull(2)]),
      api()
        .get(`/repos/${REPO}/pulls/1/reviews?per_page=100`)
        .reply(failedRead === "reviews" ? 500 : 200, [])
        .get(`/repos/${REPO}/pulls/1`)
        .reply(failedRead === "pull" ? 500 : 200, pull()),
      reads(pull(2)),
      commentRead(2),
      api().post(`/repos/${REPO}/issues/2/comments`).reply(201, {}),
    ];
    expect(await refresh()).toEqual({ checked: 2, failed: [1] });
    expect(updates).not.toHaveBeenCalled();
    handleScope(scopes);
  }
);

test("isolates comment write errors and returns the affected PRs", async () => {
  const scopes = [
    search([pull(1), pull(2)]),
    reads(pull(1)),
    commentRead(1),
    api().post(`/repos/${REPO}/issues/1/comments`).reply(500),
    reads(pull(2)),
    commentRead(2),
    api().post(`/repos/${REPO}/issues/2/comments`).reply(201, {}),
  ];
  expect(await refresh()).toEqual({ checked: 2, failed: [1] });
  handleScope(scopes);
});

test("rotates a numeric, deduplicated batch across all results without saved state", async () => {
  const numbers = Array.from({ length: 203 }, (_, i) => i + 1);
  jest.spyOn(searchUtils, "searchPullRequestsByCreatedAt").mockResolvedValue(
    [...numbers]
      .reverse()
      .concat([1, 2, 3])
      .map((number) => pull(number)) as any
  );
  const stateRead = jest
    .spyOn(prStatus, "fetchPrStatusState")
    .mockResolvedValue({
      labels: ["in progress"],
      isApproved: false,
      assignedReviewers: [],
    });
  const upsert = jest.spyOn(drci, "upsertPrStatusSection").mockResolvedValue();
  const checked = new Set<number>();
  for (let run = 0; run < 3; run++) {
    stateRead.mockClear();
    const result = await refreshPrStatusComments(
      reader,
      writer,
      "pytorch",
      "pytorch",
      run * 15 * 60 * 1000
    );
    expect(result).toEqual({ checked: 100, failed: [] });
    const batch = stateRead.mock.calls.map((call) => call[3]);
    expect(batch).toEqual(
      [
        ...numbers.slice((run * 100) % numbers.length),
        ...numbers.slice(0, (run * 100) % numbers.length),
      ].slice(0, 100)
    );
    batch.forEach((number) => checked.add(number));
  }
  expect([...checked].sort((a, b) => a - b)).toEqual(numbers);
  expect(upsert).toHaveBeenCalledTimes(300);
});
