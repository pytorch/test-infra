import {
  buildPrNotificationsManifest,
  getManifestKey,
} from "lib/prNotifications";
import * as prStatus from "lib/prStatus";
import nock from "nock";
import { handleScope } from "./common";
import * as utils from "./utils";

nock.disableNetConnect();

const AUTHOR = "author";
const NOW = new Date("2026-10-05T12:00:00Z");

function searchItem(number: number, labels: string[]) {
  return {
    number,
    title: `PR ${number}`,
    html_url: `https://github.com/pytorch/pytorch/pull/${number}`,
    user: { login: AUTHOR },
    labels: labels.map((name) => ({ name })),
  };
}

function mockSearch(qualifier: string, items: object[]) {
  return nock("https://api.github.com")
    .get("/search/issues")
    .query((query) => (query.q as string).includes(qualifier))
    .reply(200, { total_count: items.length, items });
}

function mockReviews(prNumber: number, reviews: object[], times = 1) {
  return nock("https://api.github.com")
    .get(`/repos/pytorch/pytorch/pulls/${prNumber}/reviews?per_page=100`)
    .times(times)
    .reply(200, reviews);
}

function mockLabeled(prNumber: number, label: string, createdAt: string) {
  return nock("https://api.github.com")
    .get(`/repos/pytorch/pytorch/issues/${prNumber}/events?per_page=100`)
    .reply(200, [
      { event: "labeled", label: { name: label }, created_at: createdAt },
    ]);
}

afterEach(() => {
  nock.cleanAll();
  jest.restoreAllMocks();
});

describe("getManifestKey", () => {
  test("uses the UTC date", () => {
    expect(getManifestKey(NOW)).toEqual(
      "review-logs/pr-notifications/manifest-2026-10-05.json"
    );
  });
});

describe("buildPrNotificationsManifest", () => {
  const octokit = utils.testOctokit();

  test("lists requested reviewers of PRs in final review and expands teams", async () => {
    const scope = [
      // Triaged PRs no longer wait on pre-review, so they aren't searched. PR 6
      // is skipped without any lookups.
      mockSearch('label:"ready for review"', [
        searchItem(1, ["ready for review", "open source"]),
        searchItem(2, ["ready for review"]),
        searchItem(3, ["ready for review"]),
        searchItem(6, ["ready for review", "missing actionable issue"]),
      ]),

      // PR 1 is an OSS PR asked of Bob
      mockReviews(1, []),
      utils.mockGetPR("pytorch/pytorch", 1, {
        requested_reviewers: [{ login: "Bob" }],
      }),
      mockLabeled(1, "ready for review", "2026-10-03T00:00:00Z"),

      // PR 2 is a maintainer PR, asked of dave directly and the infra team
      mockReviews(2, []),
      utils.mockGetPR("pytorch/pytorch", 2, {
        requested_reviewers: [{ login: "dave" }],
        requested_teams: [{ slug: "infra" }],
      }),
      mockLabeled(2, "ready for review", "2026-10-04T00:00:00Z"),

      // PR 3 is approved, so it isn't waiting on anyone
      utils.mockGetPR("pytorch/pytorch", 3, { draft: false }),
      mockReviews(3, [
        {
          user: { login: "dave" },
          state: "APPROVED",
          author_association: "MEMBER",
          submitted_at: "2026-10-04T00:00:00Z",
        },
      ]),

      // The author is left out of the team
      nock("https://api.github.com")
        .get("/orgs/pytorch/teams/infra/members?per_page=100")
        .reply(200, [{ login: "carol" }, { login: "dave" }, { login: AUTHOR }]),
    ];

    const manifest = await buildPrNotificationsManifest(
      octokit,
      "pytorch",
      "pytorch",
      NOW
    );
    handleScope(scope);

    expect(manifest).toEqual({
      generated_at: "2026-10-05T12:00:00.000Z",
      prs: {
        1: {
          title: "PR 1",
          url: "https://github.com/pytorch/pytorch/pull/1",
          author: AUTHOR,
          open_source: true,
          stage: "final_review",
          stage_since: "2026-10-03T00:00:00Z",
        },
        2: {
          title: "PR 2",
          url: "https://github.com/pytorch/pytorch/pull/2",
          author: AUTHOR,
          open_source: false,
          stage: "final_review",
          stage_since: "2026-10-04T00:00:00Z",
        },
      },
      reviewers: {
        // Lowercase, whatever GitHub returned
        bob: { pre_review: [], final_review: [{ pr: 1 }] },
        carol: {
          pre_review: [],
          final_review: [{ pr: 2, via: "pytorch/infra" }],
        },
        // Asked directly, so the team doesn't show
        dave: { pre_review: [], final_review: [{ pr: 2 }] },
      },
      failed_prs: [],
    });
  });

  test("keeps final-review reminders when merge verification is unavailable", async () => {
    jest.spyOn(prStatus, "fetchPrStatusState").mockResolvedValue({
      labels: ["ready for review"],
      isApproved: true,
      mergeApprovalLookupFailed: true,
      assignedReviewers: [],
      requestedReviewers: ["bob"],
    });
    const scopes = [
      mockSearch('label:"ready for review"', [
        searchItem(1, ["ready for review"]),
      ]),
      mockLabeled(1, "ready for review", "2026-10-01T00:00:00Z"),
    ];
    const manifest = await buildPrNotificationsManifest(
      octokit,
      "pytorch",
      "pytorch",
      NOW
    );
    handleScope(scopes);
    expect(manifest.reviewers.bob.final_review).toEqual([{ pr: 1 }]);
  });

  test("records PRs that could not be checked", async () => {
    const scope = [
      mockSearch('label:"ready for review"', [
        searchItem(4, ["ready for review"]),
      ]),
      nock("https://api.github.com")
        .get("/repos/pytorch/pytorch/pulls/4/reviews?per_page=100")
        .reply(500),
      utils.mockGetPR("pytorch/pytorch", 4, { draft: false }),
    ];
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const error = jest.spyOn(console, "error").mockImplementation(() => {});

    const manifest = await buildPrNotificationsManifest(
      octokit,
      "pytorch",
      "pytorch",
      NOW
    );
    handleScope(scope);
    expect(manifest.failed_prs).toEqual([4]);
    expect(manifest.reviewers).toEqual({});
    expect(error).toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });
});
