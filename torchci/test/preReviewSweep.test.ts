import * as preReview from "lib/bot/preReviewUtils";
import * as clickhouse from "lib/clickhouse";
import * as workflows from "lib/fetchRecentWorkflows";
import * as github from "lib/github";
import * as rechecks from "lib/preReviewRechecks";
import { NextApiRequest } from "next";
import nock from "nock";
import drci from "../pages/api/drci/drci";
import handler from "../pages/api/pre_review/sweep";
import { mockRes } from "./nextApiMocks";
import { testOctokit } from "./utils";

nock.disableNetConnect();

describe("scheduled pre-review sweep", () => {
  const savedBotKey = process.env.DRCI_BOT_KEY;
  const reader = testOctokit();
  const labeler = testOctokit();
  const previous = {
    123: { updatedAt: "2026-10-29T00:00:00Z", nextCheckAt: 1234 },
  };
  const result = {
    checked: 1,
    deferred: 0,
    failed: [] as number[],
    rechecks: {},
  };

  function req(overrides = {}) {
    return {
      method: "POST",
      headers: { authorization: "test-bot-key" },
      query: {},
      body: {},
      ...overrides,
    } as NextApiRequest;
  }

  beforeEach(() => {
    process.env.DRCI_BOT_KEY = "test-bot-key";
    jest.spyOn(github, "getPreReviewOctokit").mockResolvedValue(reader);
    jest.spyOn(github, "getOctokit").mockResolvedValue(labeler);
    jest.spyOn(rechecks, "loadPreReviewRechecks").mockResolvedValue(previous);
    jest.spyOn(rechecks, "savePreReviewRechecks").mockResolvedValue();
    jest.spyOn(preReview, "updateInProgressLabels").mockResolvedValue(result);
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (savedBotKey === undefined) {
      delete process.env.DRCI_BOT_KEY;
    } else {
      process.env.DRCI_BOT_KEY = savedBotKey;
    }
  });

  test("runs independently of Dr.CI and persists backoff across invocations", async () => {
    const ci = jest
      .spyOn(workflows, "fetchRecentWorkflows")
      .mockRejectedValue(new Error("CI unavailable"));
    const res = mockRes();
    await handler(req(), res);
    expect(preReview.updateInProgressLabels).toHaveBeenCalledWith(
      reader,
      labeler,
      "pytorch",
      "pytorch",
      previous
    );
    expect(rechecks.savePreReviewRechecks).toHaveBeenCalledWith(
      result.rechecks
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ checked: 1, deferred: 0, failed_prs: [] });
    expect(ci).not.toHaveBeenCalled();
  });

  test("Dr.CI no longer runs or waits for the pre-review sweep", async () => {
    jest
      .spyOn(workflows, "fetchRecentWorkflows")
      .mockRejectedValue(new Error("CI unavailable"));
    jest.spyOn(clickhouse, "queryClickhouse").mockResolvedValue([]);
    const res = mockRes();
    await drci(req({ body: { repo: "pytorch", org: "pytorch" } }), res);
    expect(res._status).toBe(400);
    expect(preReview.updateInProgressLabels).not.toHaveBeenCalled();
    expect(github.getPreReviewOctokit).not.toHaveBeenCalled();
  });

  test.each([
    { method: "GET", status: 405 },
    { headers: {}, status: 403 },
    { headers: { authorization: "wrong" }, status: 403 },
  ])(
    "rejects unauthorized/non-POST requests before accessing the apps: %j",
    async ({ status, ...overrides }) => {
      const res = mockRes();
      await handler(req(overrides), res);
      expect(res._status).toBe(status);
      expect(github.getPreReviewOctokit).not.toHaveBeenCalled();
    }
  );

  test("an unset bot key cannot authenticate an anonymous request", async () => {
    delete process.env.DRCI_BOT_KEY;
    const res = mockRes();
    await handler(req({ headers: {} }), res);
    expect(res._status).toBe(403);
    expect(github.getPreReviewOctokit).not.toHaveBeenCalled();
  });

  test("never falls back to PyTorchBot when the pre-review app is unconfigured", async () => {
    jest.mocked(github.getPreReviewOctokit).mockResolvedValue(null);
    const res = mockRes();
    await handler(req(), res);
    expect(res._status).toBe(503);
    expect(github.getOctokit).not.toHaveBeenCalled();
    expect(preReview.updateInProgressLabels).not.toHaveBeenCalled();
  });

  test("does not perform an unthrottled sweep when its backoff store fails", async () => {
    jest
      .mocked(rechecks.loadPreReviewRechecks)
      .mockRejectedValue(new Error("S3 unavailable"));
    const res = mockRes();
    await handler(req(), res);
    expect(res._status).toBe(503);
    expect(preReview.updateInProgressLabels).not.toHaveBeenCalled();
  });

  test("records successful backoff even when some PRs fail, and fails the scheduled job", async () => {
    jest
      .mocked(preReview.updateInProgressLabels)
      .mockResolvedValue({ ...result, failed: [456] });
    const res = mockRes();
    await handler(req(), res);
    expect(res._status).toBe(502);
    expect(res._json.failed_prs).toEqual([456]);
    expect(rechecks.savePreReviewRechecks).toHaveBeenCalledWith(
      result.rechecks
    );
  });
});
