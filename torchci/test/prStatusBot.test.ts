import prStatusBot from "lib/bot/prStatusBot";
import { DRCI_COMMENT_AUTHOR, DRCI_COMMENT_START } from "lib/drciUtils";
import nock from "nock";
import { Probot } from "probot";
import { handleScope, requireDeepCopy } from "./common";
import * as utils from "./utils";

nock.disableNetConnect();

const REPO = "pytorch/pytorch";
const PR_NUMBER = 4;
const REVIEWER = "maintainer";

function reviewEvent(state: string, labels: string[]) {
  const event = requireDeepCopy("./fixtures/pull_request_review.json");
  event.payload.repository.owner.login = "pytorch";
  event.payload.repository.name = "pytorch";
  event.payload.repository.full_name = REPO;
  event.payload.pull_request.number = PR_NUMBER;
  event.payload.pull_request.labels = labels.map((name) => ({ name }));
  event.payload.review.state = state;
  event.payload.review.user.login = REVIEWER;
  event.payload.review.author_association = "MEMBER";
  return event;
}

function labelEvent(
  action: "labeled" | "unlabeled",
  label: string,
  labels: string[]
) {
  const payload = requireDeepCopy("./fixtures/pull_request.labeled.json");
  payload.repository.owner.login = "pytorch";
  payload.repository.name = "pytorch";
  payload.repository.full_name = REPO;
  payload.pull_request.number = PR_NUMBER;
  payload.pull_request.labels = labels.map((name) => ({ name }));
  payload.action = action;
  payload.label.name = label;
  return { name: "pull_request", payload, id: "2" } as any;
}

function mockLiveLabels(labels: string[]) {
  return nock("https://api.github.com")
    .get(`/repos/${REPO}/issues/${PR_NUMBER}/labels?per_page=100`)
    .reply(
      200,
      labels.map((name) => ({ name }))
    );
}

// Exercise real rendering; a missing Dr.CI comment stops before writing.
function mockStatusRefresh(reviews: any[] = [], message?: string) {
  const scope = nock("https://api.github.com")
    .get(`/repos/${REPO}/pulls/${PR_NUMBER}/reviews?per_page=100`)
    .reply(200, reviews)
    .get(`/repos/${REPO}/issues/${PR_NUMBER}/comments`)
    .reply(
      200,
      message
        ? [
            {
              id: 10,
              user: { login: DRCI_COMMENT_AUTHOR },
              body: `${DRCI_COMMENT_START}## Helpful Links\n`,
            },
          ]
        : []
    );
  if (message) {
    scope
      .patch(`/repos/${REPO}/issues/comments/10`, (body) => {
        expect(body.body).toContain(message);
        expect(body.body).toContain("## Helpful Links");
        return true;
      })
      .reply(200, {});
  }
  return scope;
}

function mockRemoveLabel(name: string, status = 200) {
  return nock("https://api.github.com")
    .delete(
      `/repos/${REPO}/issues/${PR_NUMBER}/labels/${encodeURIComponent(name)}`
    )
    .reply(status, []);
}

describe("prStatusBot", () => {
  let probot: Probot;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(prStatusBot);
  });

  afterEach(() => {
    nock.cleanAll();
  });

  test.each(["changes_requested", "CHANGES_REQUESTED"])(
    "%s by a maintainer moves a ready PR back and refreshes its comment",
    async (state) => {
      const event = reviewEvent(state, ["ready for review"]);
      const add = utils.mockAddLabels(["in progress"], REPO, PR_NUMBER);
      const remove = nock("https://api.github.com")
        .delete(
          `/repos/${REPO}/issues/${PR_NUMBER}/labels/ready%20for%20review`
        )
        .reply(() => {
          expect(add.isDone()).toBe(true);
          return [200, []];
        });
      const scopes = [
        mockLiveLabels(["ready for review"]),
        utils.mockPermissions(REPO, REVIEWER, "write"),
        add,
        remove,
        mockLiveLabels(["in progress"]),
        mockStatusRefresh([event.payload.review], "## PR Status: in progress"),
      ];
      await probot.receive(event);
      handleScope(scopes);
    }
  );

  test.each(["read", "triage"])(
    "a reviewer with %s access does not move the PR",
    async (permission) => {
      const scopes = [
        mockLiveLabels(["ready for review"]),
        utils.mockPermissions(REPO, REVIEWER, permission),
        mockStatusRefresh(),
      ];
      await probot.receive(
        reviewEvent("changes_requested", ["ready for review"])
      );
      handleScope(scopes);
    }
  );

  test("a failed permission lookup keeps the labels", async () => {
    const scopes = [
      mockLiveLabels(["ready for review"]),
      nock("https://api.github.com")
        .get(`/repos/${REPO}/collaborators/${REVIEWER}/permission`)
        .reply(500),
      mockStatusRefresh(),
    ];
    await probot.receive(
      reviewEvent("changes_requested", ["ready for review"])
    );
    handleScope(scopes);
  });

  test("changes requested by a bot keeps the labels", async () => {
    const event = reviewEvent("changes_requested", ["ready for review"]);
    event.payload.review.user.login = "pytorchgreenlight[bot]";
    const scopes = [mockLiveLabels(["ready for review"]), mockStatusRefresh()];
    await probot.receive(event);
    handleScope(scopes);
  });

  test.each([
    ["ready for review", "no automated review"],
    ["ready for review"],
  ])(
    "an opted-out PR keeps ready status, including a stale review snapshot %j",
    async (...payloadLabels) => {
      const event = reviewEvent("changes_requested", payloadLabels);
      const scopes = [
        mockLiveLabels(["ready for review", "no automated review"]),
        mockStatusRefresh(
          [event.payload.review],
          "## PR Status: ready for maintainer review"
        ),
      ];
      // No permission or label mutation mocks: neither is needed for an opt-out.
      await probot.receive(event);
      handleScope(scopes);
    }
  );

  test("an opt-out removed since the review snapshot no longer prevents demotion", async () => {
    const scopes = [
      mockLiveLabels(["ready for review"]),
      utils.mockPermissions(REPO, REVIEWER, "write"),
      utils.mockAddLabels(["in progress"], REPO, PR_NUMBER),
      mockRemoveLabel("ready for review"),
      mockLiveLabels(["in progress"]),
      mockStatusRefresh(),
    ];
    await probot.receive(
      reviewEvent("changes_requested", [
        "ready for review",
        "no automated review",
      ])
    );
    handleScope(scopes);
  });

  test("a replay after the label move only refreshes status", async () => {
    const scopes = [mockLiveLabels(["in progress"]), mockStatusRefresh()];
    await probot.receive(
      reviewEvent("changes_requested", ["ready for review"])
    );
    handleScope(scopes);
  });

  test("an already-removed ready label does not fail the move", async () => {
    const scopes = [
      mockLiveLabels(["ready for review", "in progress"]),
      utils.mockPermissions(REPO, REVIEWER, "write"),
      utils.mockAddLabels(["in progress"], REPO, PR_NUMBER),
      mockRemoveLabel("ready for review", 404),
      mockLiveLabels(["in progress"]),
      mockStatusRefresh(),
    ];
    await probot.receive(
      reviewEvent("changes_requested", ["ready for review"])
    );
    handleScope(scopes);
  });

  test("a failed label removal surfaces for retry", async () => {
    const scopes = [
      mockLiveLabels(["ready for review"]),
      utils.mockPermissions(REPO, REVIEWER, "write"),
      utils.mockAddLabels(["in progress"], REPO, PR_NUMBER),
      mockRemoveLabel("ready for review", 500),
    ];
    await expect(
      probot.receive(reviewEvent("changes_requested", ["ready for review"]))
    ).rejects.toMatchObject({
      errors: [expect.objectContaining({ status: 500 })],
    });
    handleScope(scopes);
  });

  test("a failed comment refresh happens after the label move", async () => {
    const scopes = [
      mockLiveLabels(["ready for review"]),
      utils.mockPermissions(REPO, REVIEWER, "write"),
      utils.mockAddLabels(["in progress"], REPO, PR_NUMBER),
      mockRemoveLabel("ready for review"),
      mockLiveLabels(["in progress"]),
      nock("https://api.github.com")
        .get(`/repos/${REPO}/pulls/${PR_NUMBER}/reviews?per_page=100`)
        .reply(200, [])
        .get(`/repos/${REPO}/issues/${PR_NUMBER}/comments`)
        .reply(500),
    ];
    await expect(
      probot.receive(reviewEvent("changes_requested", ["ready for review"]))
    ).rejects.toMatchObject({
      errors: [expect.objectContaining({ status: 500 })],
    });
    handleScope(scopes);
  });

  test("a failed live-label lookup preserves labels and comment", async () => {
    const scope = nock("https://api.github.com")
      .get(`/repos/${REPO}/issues/${PR_NUMBER}/labels?per_page=100`)
      .reply(500);
    await expect(
      probot.receive(reviewEvent("changes_requested", ["ready for review"]))
    ).rejects.toMatchObject({
      errors: [expect.objectContaining({ status: 500 })],
    });
    handleScope(scope);
  });

  test("changes requested on an in-progress PR keeps the labels", async () => {
    const scope = mockStatusRefresh();
    await probot.receive(reviewEvent("changes_requested", ["in progress"]));
    handleScope(scope);
  });

  test.each(["approved", "commented"])(
    "%s review on a ready PR keeps the labels",
    async (state) => {
      const scope = mockStatusRefresh();
      await probot.receive(reviewEvent(state, ["ready for review"]));
      handleScope(scope);
    }
  );

  test.each([
    ["labeled", "in progress", ["ready for review", "in progress"]],
    ["unlabeled", "ready for review", ["in progress"]],
  ] as const)(
    "%s webhook from a move renders the live labels",
    async (action, label, payloadLabels) => {
      const scopes = [
        mockLiveLabels(["in progress"]),
        mockStatusRefresh([], "## PR Status: in progress"),
      ];
      await probot.receive(labelEvent(action, label, [...payloadLabels]));
      handleScope(scopes);
    }
  );

  test.each(["no automated review", "in progress"])(
    "opt-out moves forward when %s arrives",
    async (label) => {
      const add = utils.mockAddLabels(["ready for review"], REPO, PR_NUMBER);
      const remove = nock("https://api.github.com")
        .delete(`/repos/${REPO}/issues/${PR_NUMBER}/labels/in%20progress`)
        .reply(() => {
          expect(add.isDone()).toBe(true);
          return [200, []];
        });
      const scopes = [
        mockLiveLabels(["in progress", "no automated review"]),
        add,
        remove,
        mockLiveLabels(["ready for review", "no automated review"]),
        mockStatusRefresh([], "## PR Status: ready for maintainer review"),
      ];
      await probot.receive(
        labelEvent("labeled", label, ["in progress", "no automated review"])
      );
      handleScope(scopes);
    }
  );

  test("a removed opt-out is not restored from an older label snapshot", async () => {
    const scopes = [mockLiveLabels(["in progress"]), mockStatusRefresh()];
    await probot.receive(
      labelEvent("labeled", "no automated review", [
        "in progress",
        "no automated review",
      ])
    );
    handleScope(scopes);
  });

  test("an unrelated label does not spend GitHub API calls", async () => {
    await probot.receive(
      labelEvent("labeled", "module: cuda", ["ready for review"])
    );
  });

  test("an opted-out PR outside in progress is left alone", async () => {
    await probot.receive(
      labelEvent("labeled", "no automated review", ["no automated review"])
    );
  });

  test("a closed PR is left alone", async () => {
    const event = reviewEvent("changes_requested", ["ready for review"]);
    event.payload.pull_request.state = "closed";
    await probot.receive(event);
  });

  test("does nothing outside pytorch/pytorch", async () => {
    const event = reviewEvent("changes_requested", ["ready for review"]);
    event.payload.repository.owner.login = "other";
    event.payload.repository.name = "repo";
    event.payload.repository.full_name = "other/repo";
    await probot.receive(event);
  });
});
