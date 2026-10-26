import * as preReview from "lib/bot/preReviewUtils";
import * as clickhouse from "lib/clickhouse";
import * as workflows from "lib/fetchRecentWorkflows";
import * as github from "lib/github";
import { NextApiRequest } from "next";
import nock from "nock";
import handler from "../pages/api/drci/drci";
import { mockRes } from "./nextApiMocks";
import { testOctokit } from "./utils";

nock.disableNetConnect();

describe("scheduled pre-review sweep", () => {
  const savedBotKey = process.env.DRCI_BOT_KEY;

  beforeEach(() => {
    process.env.DRCI_BOT_KEY = "test-bot-key";
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (savedBotKey === undefined) {
      delete process.env.DRCI_BOT_KEY;
    } else {
      process.env.DRCI_BOT_KEY = savedBotKey;
    }
  });

  test.each([
    { repo: "pytorch", query: {}, scheduled: true },
    { repo: "pytorch", query: { prNumber: "123" }, scheduled: false },
    { repo: "vision", query: {}, scheduled: false },
  ])(
    "runs before CI updates, only on the scheduled pytorch sweep: %j",
    async ({ repo, query, scheduled }) => {
      const octokit = testOctokit();
      jest.spyOn(github, "getOctokit").mockResolvedValue(octokit);
      const sweep = jest
        .spyOn(preReview, "updateInProgressLabels")
        .mockResolvedValue();
      // The deadline check must run even when the CI data source is unavailable.
      const fetchWorkflows = jest
        .spyOn(workflows, "fetchRecentWorkflows")
        .mockRejectedValue(new Error("CI data unavailable"));
      jest.spyOn(clickhouse, "queryClickhouse").mockResolvedValue([]);
      jest.spyOn(console, "error").mockImplementation(() => {});
      const res = mockRes();

      await handler(
        {
          method: "POST",
          headers: { authorization: "test-bot-key" },
          body: { org: "pytorch", repo },
          query,
        } as unknown as NextApiRequest,
        res
      );

      expect(res._status).toBe(400);
      expect(res._json.error).toBe("CI data unavailable");
      if (scheduled) {
        expect(sweep).toHaveBeenCalledWith(octokit, "pytorch", "pytorch");
        expect(sweep.mock.invocationCallOrder[0]).toBeLessThan(
          fetchWorkflows.mock.invocationCallOrder[0]
        );
      } else {
        expect(sweep).not.toHaveBeenCalled();
      }
    }
  );
});
