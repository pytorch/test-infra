import approvalClearsReview, {
  APPROVED_DISMISSAL,
} from "lib/prReview/approvalClearsReview";
import nock from "nock";
import { Probot } from "probot";
import { handleScope, requireDeepCopy } from "./common";
import * as utils from "./utils";

nock.disableNetConnect();

const REPO = "pytorch/pytorch";
const PR_NUMBER = 4;
const APPROVER = "maintainer";
const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const MERGE_RULES = `
- name: Core
  patterns: ["torch/**"]
  approved_by: [${APPROVER}]
`;

function approvalEvent(login = APPROVER, type = "User", repo = "pytorch") {
  const event = requireDeepCopy("./fixtures/pull_request_review.json");
  event.payload.repository.owner.login = "pytorch";
  event.payload.repository.name = repo;
  event.payload.repository.full_name = `pytorch/${repo}`;
  event.payload.pull_request.number = PR_NUMBER;
  event.payload.pull_request.state = "open";
  event.payload.review.state = "approved";
  event.payload.review.user.login = login;
  event.payload.review.user.type = type;
  return event;
}

function botRequest(id: number, commit = HEAD) {
  return {
    id,
    user: { login: "github-actions[bot]", type: "Bot" },
    state: "CHANGES_REQUESTED",
    body: "<!-- hardened-pr-review -->\n**Automated review** of ...",
    commit_id: commit,
    author_association: "CONTRIBUTOR",
    submitted_at: "2026-01-01T00:00:00Z",
  };
}

function humanApproval(login = APPROVER, commit = HEAD) {
  return {
    id: 50,
    user: { login, type: "User" },
    state: "APPROVED",
    body: "",
    commit_id: commit,
    author_association: "MEMBER",
    submitted_at: "2026-01-02T00:00:00Z",
  };
}

function mockReviews(reviews: any[]) {
  return nock("https://api.github.com")
    .get(`/repos/${REPO}/pulls/${PR_NUMBER}/reviews?per_page=100`)
    .reply(200, reviews);
}

function mockMergeRules(files = ["torch/x.py"]) {
  return nock("https://api.github.com")
    .get("/repos/pytorch/pytorch/contents/.github%2Fmerge_rules.yaml")
    .reply(200, { content: Buffer.from(MERGE_RULES).toString("base64") })
    .get(`/repos/${REPO}/pulls/${PR_NUMBER}/files?per_page=100`)
    .reply(
      200,
      files.map((filename) => ({ filename }))
    );
}

function mockLive(labels: string[] = ["in progress"], draft = false) {
  return nock("https://api.github.com")
    .get(`/repos/${REPO}/pulls/${PR_NUMBER}`)
    .reply(200, {
      state: "open",
      draft,
      head: { sha: HEAD },
      labels: labels.map((name) => ({ name })),
    });
}

// `after`, when given, must be done before the dismissal.
function mockDismiss(id: number, after?: nock.Scope) {
  return nock("https://api.github.com")
    .put(
      `/repos/${REPO}/pulls/${PR_NUMBER}/reviews/${id}/dismissals`,
      (body) => {
        expect(after?.isDone() ?? true).toBe(true);
        expect(body.message).toBe(APPROVED_DISMISSAL);
        return true;
      }
    )
    .reply(200, {});
}

function mockCycleLabel() {
  const remove = nock("https://api.github.com")
    .delete(`/repos/${REPO}/issues/${PR_NUMBER}/labels/in%20progress`)
    .reply(200, []);
  const add = nock("https://api.github.com")
    .post(`/repos/${REPO}/issues/${PR_NUMBER}/labels`, (body) => {
      expect(remove.isDone()).toBe(true);
      expect(body).toMatchObject({ labels: ["in progress"] });
      return true;
    })
    .reply(200, {});
  return [remove, add];
}

describe("approvalClearsReview", () => {
  let probot: Probot;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(approvalClearsReview);
  });

  afterEach(() => {
    nock.cleanAll();
  });

  test("an approval dismisses a change request on the current head", async () => {
    const scopes = [
      mockReviews([botRequest(10), humanApproval()]),
      mockMergeRules(),
      mockLive(),
      mockDismiss(10),
    ];
    await probot.receive(approvalEvent());
    handleScope(scopes);
  });

  test("an approval of the head dismisses a request on an older commit without a re-run", async () => {
    const scopes = [
      mockReviews([botRequest(10, OLD), humanApproval()]),
      mockMergeRules(),
      mockLive(),
      mockDismiss(10),
    ];
    await probot.receive(approvalEvent());
    handleScope(scopes);
  });

  test("an approval of the request's own commit dismisses it after a push", async () => {
    const scopes = [
      mockReviews([botRequest(10, OLD), humanApproval(APPROVER, OLD)]),
      mockMergeRules(),
      mockLive(),
      mockDismiss(10),
    ];
    await probot.receive(approvalEvent());
    handleScope(scopes);
  });

  test("an approval of an earlier commit re-runs the review and leaves the request", async () => {
    const scopes = [
      mockReviews([botRequest(10), humanApproval(APPROVER, OLD)]),
      mockMergeRules(),
      mockLive(),
      ...mockCycleLabel(),
    ];
    await probot.receive(approvalEvent());
    handleScope(scopes);
  });

  test("a failed re-run still dismisses what the approval covers", async () => {
    const older = {
      ...botRequest(11, OLD),
      submitted_at: "2025-12-01T00:00:00Z",
    };
    const scopes = [
      mockReviews([older, botRequest(10), humanApproval(APPROVER, OLD)]),
      mockMergeRules(),
      mockLive(),
      nock("https://api.github.com")
        .delete(`/repos/${REPO}/issues/${PR_NUMBER}/labels/in%20progress`)
        .reply(200, [])
        .post(`/repos/${REPO}/issues/${PR_NUMBER}/labels`)
        .reply(500),
      mockDismiss(11),
    ];
    await probot.receive(approvalEvent());
    handleScope(scopes);
  });

  test.each([
    [["in progress", "ready for review"], false],
    [["in progress", "no automated review"], false],
    [["in progress"], true],
  ])(
    "a PR that will not be reviewed again (labels %j, draft %s) is not re-run",
    async (labels, draft) => {
      const scopes = [
        mockReviews([botRequest(10), humanApproval(APPROVER, OLD)]),
        mockMergeRules(),
        mockLive(labels, draft),
      ];
      await probot.receive(approvalEvent());
      handleScope(scopes);
    }
  );

  test("a change request posted after a binding approval is dismissed", async () => {
    const event = approvalEvent("github-actions[bot]", "Bot");
    Object.assign(event.payload.review, botRequest(10));
    event.payload.review.state = "changes_requested";
    const scopes = [
      mockReviews([humanApproval(), botRequest(10)]),
      mockMergeRules(),
      mockLive(),
      mockDismiss(10),
    ];
    await probot.receive(event);
    handleScope(scopes);
  });

  test("a change request on a commit after the approval stands", async () => {
    const event = approvalEvent("github-actions[bot]", "Bot");
    Object.assign(event.payload.review, botRequest(10));
    event.payload.review.state = "changes_requested";
    const scopes = [
      mockReviews([humanApproval(APPROVER, OLD), botRequest(10)]),
      mockMergeRules(),
      mockLive(),
    ];
    await probot.receive(event);
    handleScope(scopes);
  });

  test("a change request without a binding approval stands", async () => {
    const event = approvalEvent("github-actions[bot]", "Bot");
    Object.assign(event.payload.review, botRequest(10));
    event.payload.review.state = "changes_requested";
    const scopes = [mockReviews([botRequest(10)])];
    await probot.receive(event);
    handleScope(scopes);
  });

  test("an approval merge_rules.yaml does not accept changes nothing", async () => {
    const scopes = [
      mockReviews([botRequest(10), humanApproval()]),
      mockMergeRules(["torch/x.py", "docs/index.md"]),
    ];
    await probot.receive(approvalEvent());
    handleScope(scopes);
  });

  test("without a standing change request nothing more is read", async () => {
    const dismissed = { ...botRequest(10), state: "DISMISSED" };
    const scopes = [mockReviews([dismissed, humanApproval()])];
    await probot.receive(approvalEvent());
    handleScope(scopes);
  });

  test("a bot's approval is ignored", async () => {
    await probot.receive(approvalEvent("pytorchgreenlight[bot]", "Bot"));
  });

  test("a comment is ignored", async () => {
    const event = approvalEvent();
    event.payload.review.state = "commented";
    await probot.receive(event);
  });

  test("other repositories are ignored", async () => {
    await probot.receive(approvalEvent(APPROVER, "User", "vision"));
  });
});
