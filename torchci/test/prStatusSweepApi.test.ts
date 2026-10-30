import * as github from "lib/github";
import * as sweep from "lib/prStatusSweep";
import { NextApiRequest } from "next";
import handler from "../pages/api/pr_status/sweep";
import { mockRes } from "./nextApiMocks";
import { testOctokit } from "./utils";

const reader = testOctokit();
const writer = testOctokit();
const savedKey = process.env.DRCI_BOT_KEY;

function req(overrides = {}) {
  return {
    method: "POST",
    headers: { authorization: "test-bot-key" },
    ...overrides,
  } as NextApiRequest;
}

beforeEach(() => {
  process.env.DRCI_BOT_KEY = "test-bot-key";
  jest.spyOn(github, "getPreReviewOctokit").mockResolvedValue(reader);
  jest.spyOn(github, "getOctokit").mockResolvedValue(writer);
  jest
    .spyOn(sweep, "refreshPrStatusComments")
    .mockResolvedValue({ checked: 2, failed: [] });
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  if (savedKey === undefined) {
    delete process.env.DRCI_BOT_KEY;
  } else {
    process.env.DRCI_BOT_KEY = savedKey;
  }
});

test("uses the dedicated reader and PyTorchBot writer without waiting for CI", async () => {
  const res = mockRes();
  await handler(req(), res);
  expect(sweep.refreshPrStatusComments).toHaveBeenCalledWith(
    reader,
    writer,
    "pytorch",
    "pytorch"
  );
  expect(res._status).toBe(200);
  expect(res._json).toEqual({ checked: 2, failed_prs: [] });
});

test.each([
  { method: "GET", status: 405 },
  { headers: {}, status: 403 },
  { headers: { authorization: "wrong" }, status: 403 },
])(
  "rejects invalid methods or credentials before app access: %j",
  async ({ status, ...overrides }) => {
    const res = mockRes();
    await handler(req(overrides), res);
    expect(res._status).toBe(status);
    expect(github.getPreReviewOctokit).not.toHaveBeenCalled();
    expect(github.getOctokit).not.toHaveBeenCalled();
  }
);

test("an unset key cannot authorize an anonymous request", async () => {
  delete process.env.DRCI_BOT_KEY;
  const res = mockRes();
  await handler(req({ headers: {} }), res);
  expect(res._status).toBe(403);
  expect(github.getPreReviewOctokit).not.toHaveBeenCalled();
});

test("missing reader configuration fails without falling back to PyTorchBot", async () => {
  jest.mocked(github.getPreReviewOctokit).mockResolvedValue(null);
  const res = mockRes();
  await handler(req(), res);
  expect(res._status).toBe(503);
  expect(github.getOctokit).not.toHaveBeenCalled();
  expect(sweep.refreshPrStatusComments).not.toHaveBeenCalled();
});

test("partial failures produce a failing cron response with the failed PR IDs", async () => {
  jest
    .mocked(sweep.refreshPrStatusComments)
    .mockResolvedValue({ checked: 2, failed: [3] });
  const res = mockRes();
  await handler(req(), res);
  expect(res._status).toBe(502);
  expect(res._json).toEqual({ checked: 2, failed_prs: [3] });
});

test("search or app errors produce a service failure", async () => {
  jest
    .mocked(sweep.refreshPrStatusComments)
    .mockRejectedValue(new Error("GitHub search unavailable"));
  const res = mockRes();
  await handler(req(), res);
  expect(res._status).toBe(503);
});
