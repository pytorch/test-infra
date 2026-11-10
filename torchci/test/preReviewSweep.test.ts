import { markInProgressIfAccepted } from "lib/bot/preReviewSweep";
import * as prStatus from "lib/prStatus";
import nock from "nock";
import { handleScope } from "./common";
import { mockAddLabels, mockGetPR, testOctokit } from "./utils";

nock.disableNetConnect();
const REPO = "pytorch/pytorch";
const reader = testOctokit();
const writer = testOctokit();
const NOW = Date.parse("2026-11-06T12:00:00Z");
const pull = (overrides = {}) => ({
  state: "open",
  draft: false,
  created_at: "2026-10-01T00:00:00Z",
  labels: [{ name: "triaged" }],
  ...overrides,
});
const promote = () =>
  markInProgressIfAccepted(reader, writer, "pytorch", "pytorch", 1);

beforeEach(() => jest.spyOn(Date, "now").mockReturnValue(NOW));
afterEach(() => {
  nock.cleanAll();
  jest.restoreAllMocks();
});

test("advances an already-approved PR without reading review or response APIs", async () => {
  // Neither snapshot approvals nor assigned reviewers influence the transition.
  const scopes = [
    mockGetPR(
      REPO,
      1,
      pull({
        requested_reviewers: [{ login: "maintainer" }],
        requested_teams: [{ slug: "core" }],
        mergeable_state: "clean",
      })
    ),
    mockAddLabels(["in progress"], REPO, 1),
  ];
  const approvals = jest
    .spyOn(prStatus, "fetchPrStatusState")
    .mockResolvedValue({
      labels: ["triaged"],

      isApproved: true,
      isMergeApproved: true,
    });
  const reads = jest.spyOn(reader, "paginate");
  const readerWrites = jest.spyOn(reader.rest.issues, "addLabels");
  const writerReads = jest.spyOn(writer.rest.pulls, "get");
  expect(await promote()).toBe(true);
  handleScope(scopes);
  expect(approvals).not.toHaveBeenCalled();
  expect(reads).not.toHaveBeenCalled();
  expect(readerWrites).not.toHaveBeenCalled();
  expect(writerReads).not.toHaveBeenCalled();
});

test.each([
  { state: "closed" },
  { draft: true },
  { created_at: "2026-08-31T23:59:59Z" },
  { created_at: "invalid" },
  { labels: [] },
  { labels: [{ name: "triaged" }, { name: "missing actionable issue" }] },
  { labels: [{ name: "triaged" }, { name: "in progress" }] },
  { labels: [{ name: "triaged" }, { name: "ready for review" }] },
])("live eligibility prevents promotion on replay: %j", async (overrides) => {
  const scope = mockGetPR(REPO, 1, pull(overrides));
  expect(await promote()).toBe(false);
  handleScope(scope);
});

test("does not read or write other owners or repositories", async () => {
  expect(
    await markInProgressIfAccepted(reader, writer, "other", "pytorch", 1)
  ).toBe(false);
  expect(
    await markInProgressIfAccepted(reader, writer, "pytorch", "vision", 1)
  ).toBe(false);
});

test("coalesces concurrent promotions and rechecks live labels on replay", async () => {
  const scopes = [
    mockGetPR(REPO, 1, pull()),
    mockAddLabels(["in progress"], REPO, 1),
  ];
  expect(await Promise.all([promote(), promote()])).toEqual([true, true]);
  handleScope(scopes);
  const replay = mockGetPR(
    REPO,
    1,
    pull({ labels: [{ name: "triaged" }, { name: "in progress" }] })
  );
  expect(await promote()).toBe(false);
  handleScope(replay);
});

test.each(["read", "write", "partial write"])(
  "retries a failed %s without duplicate review labels",
  async (failure) => {
    const first = nock("https://api.github.com")
      .get(`/repos/${REPO}/pulls/1`)
      .reply(failure === "read" ? 503 : 200, pull());
    if (failure !== "read")
      first
        .post(`/repos/${REPO}/issues/1/labels`, { labels: ["in progress"] })
        .reply(503);
    await expect(promote()).rejects.toMatchObject({ status: 503 });
    handleScope(first);
    const retry = [
      mockGetPR(
        REPO,
        1,
        pull({
          labels:
            failure === "partial write"
              ? [{ name: "triaged" }, { name: "in progress" }]
              : [{ name: "triaged" }],
        })
      ),
    ];
    if (failure !== "partial write")
      retry.push(mockAddLabels(["in progress"], REPO, 1));
    expect(await promote()).toBe(failure !== "partial write");
    handleScope(retry);
  }
);
