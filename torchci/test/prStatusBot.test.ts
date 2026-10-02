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
  return event;
}

function labelEvent(
  action: "labeled" | "unlabeled",
  label: string,
  labels: string[]
) {
  const event = reviewEvent("commented", labels);
  event.name = "pull_request";
  event.payload.action = action;
  event.payload.label = { name: label };
  delete event.payload.review;
  return event;
}

// The PR Status refresh that runs on every workflow-labeled review. No Dr.CI
// comment exists, so it stops before writing anything.
function mockStatusRefresh() {
  return nock("https://api.github.com")
    .get(`/repos/${REPO}/pulls/${PR_NUMBER}/reviews?per_page=100`)
    .reply(200, [])
    .get(`/repos/${REPO}/issues/${PR_NUMBER}/comments`)
    .reply(200, []);
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

  test("maintainer requesting changes moves a ready PR back to in progress", async () => {
    // No comment refresh: the label webhooks render the new status, so a
    // failing comment update cannot block the move.
    const scopes = [
      utils.mockPermissions(REPO, REVIEWER, "write"),
      utils.mockAddLabels(["in progress"], REPO, PR_NUMBER),
      nock("https://api.github.com")
        .delete(
          `/repos/${REPO}/issues/${PR_NUMBER}/labels/${encodeURIComponent(
            "ready for review"
          )}`
        )
        .reply(200, []),
    ];
    await probot.receive(
      reviewEvent("changes_requested", ["ready for review"])
    );
    handleScope(scopes);
  });

  test("changes requested without write access keeps the labels", async () => {
    const scopes = [
      mockStatusRefresh(),
      utils.mockPermissions(REPO, REVIEWER, "read"),
    ];
    await probot.receive(
      reviewEvent("changes_requested", ["ready for review"])
    );
    handleScope(scopes);
  });

  test("changes requested keeps the labels when the permission lookup fails", async () => {
    const scopes = [
      mockStatusRefresh(),
      nock("https://api.github.com")
        .get(`/repos/${REPO}/collaborators/${REVIEWER}/permission`)
        .reply(500),
    ];
    await probot.receive(
      reviewEvent("changes_requested", ["ready for review"])
    );
    handleScope(scopes);
  });

  test("changes requested by a bot keeps the labels", async () => {
    const event = reviewEvent("changes_requested", ["ready for review"]);
    event.payload.review.user.login = "pytorchgreenlight[bot]";
    // No permission lookup: bots never count as maintainers.
    const scopes = [mockStatusRefresh()];
    await probot.receive(event);
    handleScope(scopes);
  });

  test("changes requested on an in progress PR keeps the labels", async () => {
    const scopes = [mockStatusRefresh()];
    await probot.receive(reviewEvent("changes_requested", ["in progress"]));
    handleScope(scopes);
  });

  test.each(["approved", "commented"])(
    "%s review on a ready PR keeps the labels",
    async (state) => {
      const scopes = [mockStatusRefresh()];
      await probot.receive(reviewEvent(state, ["ready for review"]));
      handleScope(scopes);
    }
  );

  test.each([
    ["labeled", "in progress", ["ready for review", "in progress"]],
    ["unlabeled", "ready for review", ["in progress"]],
  ] as const)(
    "%s webhook from a move renders the live labels",
    async (action, label, payloadLabels) => {
      const scopes = [
        nock("https://api.github.com")
          .get(`/repos/${REPO}/issues/${PR_NUMBER}/labels?per_page=100`)
          .reply(200, [{ name: "in progress" }])
          .get(`/repos/${REPO}/pulls/${PR_NUMBER}/reviews?per_page=100`)
          .reply(200, [])
          .get(`/repos/${REPO}/issues/${PR_NUMBER}/comments`)
          .reply(200, [
            {
              id: 10,
              user: { login: DRCI_COMMENT_AUTHOR },
              body: `${DRCI_COMMENT_START}## Helpful Links\n`,
            },
          ])
          .patch(`/repos/${REPO}/issues/comments/10`, (body) => {
            expect(body.body).toContain("## PR Status: in progress");
            return true;
          })
          .reply(200, {}),
      ];
      await probot.receive(labelEvent(action, label, [...payloadLabels]));
      handleScope(scopes);
    }
  );

  test("does nothing outside pytorch/pytorch", async () => {
    const event = reviewEvent("changes_requested", ["ready for review"]);
    event.payload.repository.owner.login = "random";
    event.payload.repository.name = "random";
    event.payload.repository.full_name = "random/random";
    const scope = nock("https://api.github.com");
    await probot.receive(event);
    handleScope(scope);
  });
});
