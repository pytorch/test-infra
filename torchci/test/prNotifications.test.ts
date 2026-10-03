import {
  buildPrNotificationsManifest,
  getManifestKey,
} from "lib/prNotifications";
import nock from "nock";
import { handleScope } from "./common";
import * as utils from "./utils";

nock.disableNetConnect();

// Turn on pre-review as if it has been rolled out
jest.mock("lib/prStatus", () => {
  const actual = jest.requireActual("lib/prStatus");
  return {
    ...actual,
    PRE_REVIEW_START_DATE: "2026-01-01",
  };
});

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
});

describe("getManifestKey", () => {
  test("uses the UTC date", () => {
    expect(getManifestKey(NOW)).toEqual(
      "pr-notifications/manifest-2026-10-05.json"
    );
  });
});

describe("buildPrNotificationsManifest", () => {
  const octokit = utils.testOctokit();

  test("lists pending reviewers per stage and expands teams", async () => {
    const pull = {
      user: { login: AUTHOR },
      requested_reviewers: [{ login: "alice" }, { login: "bob" }],
      requested_teams: [{ slug: "infra" }],
    };
    const scope = [
      mockSearch('label:"ready for review"', [
        searchItem(2, ["ready for review"]),
        searchItem(3, ["ready for review"]),
      ]),
      mockSearch('label:"triaged"', [searchItem(1, ["triaged"])]),

      // PR 1 is in pre-review, and alice already agreed with a thumbs-up
      mockReviews(1, []),
      utils.mockGetPR("pytorch/pytorch", 1, pull),
      nock("https://api.github.com")
        .get("/repos/pytorch/pytorch/issues/1/timeline?per_page=100")
        .reply(200, [])
        .get(
          "/repos/pytorch/pytorch/issues/1/reactions?content=%2B1&per_page=100"
        )
        .reply(200, [{ content: "+1", user: { login: "alice" } }]),
      mockLabeled(1, "triaged", "2026-10-01T00:00:00Z"),

      // PR 2 is in final review, asked of dave directly and the infra team
      mockReviews(2, []),
      utils.mockGetPR("pytorch/pytorch", 2, {
        requested_reviewers: [{ login: "dave" }],
        requested_teams: [{ slug: "infra" }],
      }),
      mockLabeled(2, "ready for review", "2026-10-04T00:00:00Z"),

      // PR 3 is approved, so it isn't waiting on anyone
      mockReviews(3, [
        {
          user: { login: "dave" },
          state: "APPROVED",
          author_association: "MEMBER",
          submitted_at: "2026-10-04T00:00:00Z",
        },
      ]),

      // Once by the pre-review check, then once for the manifest, which
      // shares it between both PRs. The author is left out.
      nock("https://api.github.com")
        .get("/orgs/pytorch/teams/infra/members?per_page=100")
        .times(2)
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
          stage: "pre_review",
          stage_since: "2026-10-01T00:00:00Z",
        },
        2: {
          title: "PR 2",
          url: "https://github.com/pytorch/pytorch/pull/2",
          author: AUTHOR,
          stage: "final_review",
          stage_since: "2026-10-04T00:00:00Z",
        },
      },
      reviewers: {
        bob: { pre_review: [{ pr: 1 }], final_review: [] },
        carol: {
          pre_review: [{ pr: 1, via: "pytorch/infra" }],
          final_review: [{ pr: 2, via: "pytorch/infra" }],
        },
        // Asked directly on PR 2, so the team doesn't show
        dave: {
          pre_review: [{ pr: 1, via: "pytorch/infra" }],
          final_review: [{ pr: 2 }],
        },
      },
      failed_prs: [],
    });
  });

  test("records PRs that could not be checked", async () => {
    const scope = [
      mockSearch('label:"ready for review"', [
        searchItem(4, ["ready for review"]),
      ]),
      // A pre-review PR whose reviewers can't be looked up isn't dropped
      mockSearch('label:"triaged"', [searchItem(5, ["triaged"])]),
      nock("https://api.github.com")
        .get("/repos/pytorch/pytorch/pulls/4/reviews?per_page=100")
        .reply(500),
      mockReviews(5, []),
      nock("https://api.github.com")
        .get("/repos/pytorch/pytorch/pulls/5")
        .reply(500),
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
    expect(manifest.failed_prs).toEqual([4, 5]);
    expect(manifest.reviewers).toEqual({});
    expect(error).toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });
});
