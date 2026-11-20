import * as botUtils from "lib/bot/utils";
import * as clickhouse from "lib/clickhouse";
import * as crcrAllowlist from "lib/crcrAllowlist";
import * as drciUtils from "lib/drciUtils";
import * as fetchIssues from "lib/fetchIssuesByLabel";
import * as fetchPR from "lib/fetchPR";
import * as workflows from "lib/fetchRecentWorkflows";
import * as github from "lib/github";
import * as greenlight from "lib/greenlight/greenlightComment";
import { PR_REVIEW_PENDING_ALT_ATTR } from "lib/greenlight/greenlightSweep";
import * as prReview from "lib/prReview/prReviewComment";
import * as promotion from "lib/prReview/readyForReviewPromotion";
import { PR_STATUS_END, PR_STATUS_START } from "lib/prStatus";
import nock from "nock";
import { updateDrciComments } from "pages/api/drci/drci";
import { handleScope } from "./common";
import { getDummyJob, testOctokit } from "./utils";

nock.disableNetConnect();

const REPO = "pytorch/pytorch";
const SHA = "abcdefg";
const OLD_SECTION = `${PR_STATUS_START}\n## PR Status: queued triaged state\n\nWaiting: alice\n${PR_STATUS_END}\n`;
const BODY = drciUtils.DRCI_COMMENT_START + OLD_SECTION + "old CI results";
const reader = testOctokit();
const writer = testOctokit();

function job(prNumber = 1) {
  return getDummyJob({
    pr_number: prNumber,
    head_sha: SHA,
    head_sha_timestamp: "2026-10-30T00:00:00Z",
    conclusion: "success",
  });
}

beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(github, "getPrStatusOctokit").mockResolvedValue(reader);
  jest.spyOn(workflows, "fetchRecentWorkflows").mockResolvedValue([job()]);
  jest.spyOn(workflows, "fetchFailedJobsFromCommits").mockResolvedValue([]);
  jest.spyOn(workflows, "fetchJobNamesFromCommits").mockResolvedValue([]);
  jest.spyOn(workflows, "fetchCrcrWorkflows").mockResolvedValue([]);
  jest
    .spyOn(fetchPR, "default")
    .mockResolvedValue({ title: "PR", body: "", shas: [] });
  jest.spyOn(fetchIssues, "default").mockResolvedValue([]);
  jest.spyOn(botUtils, "fetchJSON").mockResolvedValue([]);
  jest
    .spyOn(crcrAllowlist, "fetchCrcrAllowlist")
    .mockResolvedValue(new crcrAllowlist.CrcrAllowlist([]));
  jest
    .spyOn(greenlight, "buildGreenlightSections")
    .mockResolvedValue(new Map());
  jest.spyOn(prReview, "buildPrReviewSections").mockResolvedValue(new Map());
  jest
    .spyOn(promotion, "fetchPrReviewHeadVerdicts")
    .mockResolvedValue(new Map());
  jest.spyOn(drciUtils, "fetchPRLabels").mockResolvedValue([]);
  jest.spyOn(drciUtils, "getPRMergeCommits").mockResolvedValue(new Map());
  jest.spyOn(clickhouse, "queryClickhouseSaved").mockResolvedValue([
    {
      head_sha: SHA,
      merge_base: "base",
      merge_base_commit_date: "2026-10-29T00:00:00Z",
    },
  ]);
  jest.spyOn(clickhouse, "queryClickhouse").mockResolvedValue(
    [1, 2].map((prNumber) => ({
      id: 10 + prNumber,
      body: BODY,
      issue_url: `https://api.github.com/repos/${REPO}/issues/${prNumber}`,
    }))
  );
  jest.spyOn(writer, "paginate");
  jest.spyOn(writer.rest.pulls, "get");
  jest.spyOn(writer.rest.issues, "updateComment").mockResolvedValue({} as any);
  jest.spyOn(writer.rest.issues, "createComment").mockResolvedValue({} as any);
  jest.spyOn(writer.rest.checks, "create").mockResolvedValue({} as any);
  jest.spyOn(reader.rest.issues, "updateComment");
  jest.spyOn(reader.rest.checks, "create");
});

afterEach(() => {
  nock.cleanAll();
  jest.restoreAllMocks();
});

function statusReads(failure = "", prNumber = 1) {
  const scope = nock("https://api.github.com")
    .get(`/repos/${REPO}/issues/${prNumber}/labels?per_page=100`)
    .reply(failure === "labels" ? 503 : 200, [{ name: "triaged" }]);
  if (failure === "labels") {
    return scope;
  }
  scope
    .get(`/repos/${REPO}/pulls/${prNumber}/reviews?per_page=100`)
    .reply(failure === "reviews" ? 503 : 200, [])
    .get(`/repos/${REPO}/pulls/${prNumber}`)
    .reply(failure === "pull" ? 503 : 200, {
      state: "open",
      draft: false,
      created_at: "2026-10-01T00:00:00Z",
      user: { login: "author" },
      labels: [{ name: "triaged" }],
      requested_reviewers: [{ login: "bob" }],
      requested_teams: [],
    });
  return scope;
}

function expectCiUpdate(section: string, commentId = 11) {
  expect(writer.rest.issues.updateComment).toHaveBeenCalledWith(
    expect.objectContaining({
      comment_id: commentId,
      body: expect.stringContaining(section),
    })
  );
  const body = jest.mocked(writer.rest.issues.updateComment).mock.calls[0][0]!
    .body!;
  expect(body).not.toContain("old CI results");
  expect(body).toContain("## :white_check_mark: No Failures");
  expect(writer.rest.checks.create).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "Dr.CI",
      head_sha: SHA,
      status: "completed",
    })
  );
  expect(writer.paginate).not.toHaveBeenCalled();
  expect(writer.rest.pulls.get).not.toHaveBeenCalled();
  expect(reader.rest.issues.updateComment).not.toHaveBeenCalled();
  expect(reader.rest.checks.create).not.toHaveBeenCalled();
}

test.each(["labels", "reviews", "pull"])(
  "a failed %s read preserves PR Status while updating the CI comment and check",
  async (failure) => {
    const scope = statusReads(failure);
    const result = await updateDrciComments(writer, "pytorch", "pytorch", [1]);
    handleScope(scope);
    expect(result[1].FAILED).toEqual([]);
    expectCiUpdate(OLD_SECTION);
  }
);

test.each(["missing credentials", "app lookup failed"])(
  "%s preserves status and never uses PyTorchBot for status reads",
  async (failure) => {
    if (failure === "missing credentials") {
      jest.mocked(github.getPrStatusOctokit).mockResolvedValue(null);
    } else {
      jest
        .mocked(github.getPrStatusOctokit)
        .mockRejectedValue(new Error("app unavailable"));
    }
    await updateDrciComments(writer, "pytorch", "pytorch", [1]);
    expectCiUpdate(OLD_SECTION);
  }
);

test("the dedicated reader is shared and replaces stale progress with queued status", async () => {
  jest
    .mocked(workflows.fetchRecentWorkflows)
    .mockResolvedValue([job(1), job(2)]);
  const scopes = [statusReads("", 1), statusReads("", 2)];
  await updateDrciComments(writer, "pytorch", "pytorch", [1, 2]);
  handleScope(scopes);
  expect(github.getPrStatusOctokit).toHaveBeenCalledTimes(1);
  expect(github.getPrStatusOctokit).toHaveBeenCalledWith("pytorch", "pytorch");
  expectCiUpdate("## PR Status: triaged");
  const body = jest.mocked(writer.rest.issues.updateComment).mock.calls[0][0]!
    .body!;
  expect(body).toContain("queued for automated review");
  expect(body).not.toContain("queued triaged state");
  expect(writer.rest.issues.updateComment).toHaveBeenCalledTimes(2);
  expect(writer.rest.checks.create).toHaveBeenCalledTimes(2);
});

test("CI can create a missing comment even when the status reader is unavailable", async () => {
  jest.mocked(github.getPrStatusOctokit).mockResolvedValue(null);
  jest.mocked(clickhouse.queryClickhouse).mockResolvedValue([]);
  const scope = nock("https://api.github.com")
    .get(`/repos/${REPO}/issues/1/comments`)
    .reply(200, []);
  await updateDrciComments(writer, "pytorch", "pytorch", [1]);
  handleScope(scope);
  expect(writer.rest.issues.createComment).toHaveBeenCalledWith(
    expect.objectContaining({
      issue_number: 1,
      body: expect.stringContaining("## :white_check_mark: No Failures"),
    })
  );
  expect(writer.rest.checks.create).toHaveBeenCalledTimes(1);
  // This is the normal missing-comment lookup, not a retry of status reads.
  expect(writer.paginate).toHaveBeenCalledTimes(1);
  expect(writer.rest.pulls.get).not.toHaveBeenCalled();
});

test("a captured review with no telemetry stays in the sweep, then reports a timeout", async () => {
  jest.useFakeTimers().setSystemTime(new Date("2026-11-10T19:00:00Z"));
  try {
    jest.mocked(github.getPrStatusOctokit).mockResolvedValue(null);
    jest.mocked(prReview.buildPrReviewSections).mockRestore();
    jest.spyOn(workflows, "fetchCrcrActivityPRs").mockResolvedValue([]);
    jest.mocked(drciUtils.fetchPRLabels).mockResolvedValue(["in progress"]);
    const capture = job();
    Object.assign(capture, {
      workflowId: 42875235669,
      workflowUniqueId: 10,
      id: 130036655409,
      workflowPath: ".github/workflows/hardened-pr-review.yml",
      workflowEvent: "pull_request_target",
      name: "Hardened PR Review / capture",
      jobName: "capture",
      completed_at: "2026-11-10 18:26:48.000000000",
      html_url:
        "https://github.com/pytorch/pytorch/actions/runs/42875235669/job/130036655409",
    });
    // A later unrelated label produces a skipped workflow. Dr.CI's CI-job
    // cleanup discards the successful older capture; recovery must use raw jobs.
    const skipped = {
      ...capture,
      workflowId: 0,
      id: capture.workflowId + 1,
      conclusion: "skipped",
    };
    jest
      .mocked(workflows.fetchRecentWorkflows)
      .mockResolvedValue([capture, skipped]);
    jest
      .mocked(clickhouse.queryClickhouseSaved)
      .mockImplementation(async (name) =>
        name === "pr_review_verdicts_for_prs"
          ? []
          : [
              {
                head_sha: SHA,
                merge_base: "base",
                merge_base_commit_date: "2026-10-29T00:00:00Z",
              },
            ]
      );
    // A past passing verdict on this head must not promote past the new request.
    jest.mocked(promotion.fetchPrReviewHeadVerdicts).mockResolvedValue(
      new Map([
        [
          1,
          {
            pr_number: 1,
            head_sha: SHA,
            status: "succeeded",
            verdict: "ready_for_human_review",
            started_at_ms: Date.parse("2026-11-10T17:00:00Z"),
          },
        ],
      ])
    );
    const promote = jest.spyOn(promotion, "maybePromoteToReadyForReview");

    await updateDrciComments(writer, "pytorch", "pytorch", []);
    let body = jest.mocked(writer.rest.issues.updateComment).mock.calls[0][0]!
      .body!;
    expect(body).toContain("Review pending");
    expect(body).toContain(PR_REVIEW_PENDING_ALT_ATTR);
    expect(clickhouse.queryClickhouse).toHaveBeenCalledWith(
      expect.stringContaining(
        "position(body, {prReviewPendingAltAttr: String}) > 0"
      ),
      expect.objectContaining({
        prReviewPendingAltAttr: PR_REVIEW_PENDING_ALT_ATTR,
      })
    );
    expect(promote).not.toHaveBeenCalled();

    jest.setSystemTime(new Date("2026-11-10T21:00:00Z"));
    jest.mocked(writer.rest.issues.updateComment).mockClear();
    await updateDrciComments(writer, "pytorch", "pytorch", []);
    body = jest.mocked(writer.rest.issues.updateComment).mock.calls[0][0]!
      .body!;
    expect(body).toContain("Review did not complete");
    expect(body).toContain("`@pytorchbot review`");
    expect(body).not.toContain(PR_REVIEW_PENDING_ALT_ATTR);
    expect(promote).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

test("a failed review-status read neither invents a failure nor promotes an old verdict", async () => {
  jest.mocked(github.getPrStatusOctokit).mockResolvedValue(null);
  jest
    .mocked(prReview.buildPrReviewSections)
    .mockRejectedValue(new Error("database unavailable"));
  jest.mocked(promotion.fetchPrReviewHeadVerdicts).mockResolvedValue(
    new Map([
      [
        1,
        {
          pr_number: 1,
          head_sha: SHA,
          status: "succeeded",
          verdict: "ready_for_human_review",
          started_at_ms: Date.parse("2026-11-10T17:00:00Z"),
        },
      ],
    ])
  );
  const promote = jest.spyOn(promotion, "maybePromoteToReadyForReview");
  await updateDrciComments(writer, "pytorch", "pytorch", [1]);
  const body = jest.mocked(writer.rest.issues.updateComment).mock.calls[0][0]!
    .body!;
  expect(body).not.toContain("AUTOMATED REVIEW");
  expect(promote).not.toHaveBeenCalled();
});
