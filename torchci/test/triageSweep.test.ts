import * as triage from "lib/bot/triageSweep";
import * as github from "lib/github";
import { NextApiRequest } from "next";
import nock from "nock";
import handler from "../pages/api/triage/sweep";
import { handleScope } from "./common";
import { mockRes } from "./nextApiMocks";
import { testOctokit } from "./utils";

nock.disableNetConnect();
const bot = testOctokit();
const savedBotKey = process.env.DRCI_BOT_KEY;
const result = { checked: 1, failed: [] as number[] };
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
  jest
    .spyOn(github, "getPrStatusOctokit")
    .mockRejectedValue(new Error("Status reader unavailable"));
  jest.spyOn(github, "getOctokit").mockResolvedValue(bot);
  jest.spyOn(triage, "updateInProgressLabels").mockResolvedValue(result);
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  nock.cleanAll();
  jest.restoreAllMocks();
  if (savedBotKey === undefined) delete process.env.DRCI_BOT_KEY;
  else process.env.DRCI_BOT_KEY = savedBotKey;
});
test("recovery uses PyTorchBot even when the dedicated status reader is unavailable", async () => {
  const res = mockRes();
  await handler(req(), res);
  expect(triage.updateInProgressLabels).toHaveBeenCalledWith(
    bot,
    bot,
    "pytorch",
    "pytorch"
  );
  expect(github.getPrStatusOctokit).not.toHaveBeenCalled();
  expect(res._status).toBe(200);
  expect(res._json).toEqual({ checked: 1, failed_prs: [] });
});
test.each([
  { method: "GET", status: 405 },
  { headers: {}, status: 403 },
  { headers: { authorization: "wrong" }, status: 403 },
])(
  "rejects unauthorized/non-POST requests before accessing apps: %j",
  async ({ status, ...overrides }) => {
    const res = mockRes();
    await handler(req(overrides), res);
    expect(res._status).toBe(status);
    expect(github.getOctokit).not.toHaveBeenCalled();
  }
);
test("an unset bot key cannot authenticate an anonymous request", async () => {
  delete process.env.DRCI_BOT_KEY;
  const res = mockRes();
  await handler(req({ headers: {} }), res);
  expect(res._status).toBe(403);
  expect(github.getOctokit).not.toHaveBeenCalled();
});
test("reports failed PRs so the scheduled job can retry", async () => {
  jest
    .mocked(triage.updateInProgressLabels)
    .mockResolvedValue({ ...result, failed: [456] });
  const res = mockRes();
  await handler(req(), res);
  expect(res._status).toBe(502);
  expect(res._json.failed_prs).toEqual([456]);
});
test("reports unavailable PyTorchBot credentials without running a sweep", async () => {
  jest
    .mocked(github.getOctokit)
    .mockRejectedValue(new Error("Bot unavailable"));
  const res = mockRes();
  await handler(req(), res);
  expect(res._status).toBe(503);
  expect(triage.updateInProgressLabels).not.toHaveBeenCalled();
});
test("splits searches above 1,000 results, reads every page, and bounds promotions", async () => {
  jest.mocked(triage.updateInProgressLabels).mockRestore();
  const now = Date.parse("2026-11-06T12:00:00Z");
  jest.spyOn(Date, "now").mockReturnValue(now);
  const since = Date.parse("2026-09-01") / 1000;
  const until = now / 1000;
  const middle = Math.floor((since + until) / 2);
  const range = (start: number, end: number) =>
    `created:${new Date(start * 1000).toISOString()}..${new Date(
      end * 1000
    ).toISOString()}`;
  const scope = nock("https://api.github.com")
    .get("/search/issues")
    .query(true)
    .times(12)
    .reply((uri) => {
      const params = new URL(uri, "https://api.github.com").searchParams;
      const query = params.get("q")!;
      expect(query).not.toMatch(/review:|reactions:/);
      if (query.includes(range(since, until)))
        return [200, { total_count: 1001, items: [] }];
      if (query.includes(range(since, middle))) {
        const page = Number(params.get("page") ?? 1);
        expect(page).toBeLessThanOrEqual(10);
        return [
          200,
          {
            total_count: 1000,
            items: Array.from({ length: 100 }, (_, i) => ({
              number: (page - 1) * 100 + i + 1,
            })),
          },
        ];
      }
      expect(query).toContain(range(middle + 1, until));
      return [200, { total_count: 1, items: [{ number: 1001 }] }];
    });
  const reads = jest
    .spyOn(bot.rest.pulls, "get")
    .mockResolvedValue({ data: { state: "closed", labels: [] } } as any);
  expect(
    await triage.updateInProgressLabels(bot, bot, "pytorch", "pytorch")
  ).toEqual({ checked: 100, failed: [] });
  handleScope(scope);
  expect(reads).toHaveBeenCalledTimes(100);
});
