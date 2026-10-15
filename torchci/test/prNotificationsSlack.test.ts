import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHmac } from "crypto";
import { NextApiRequest } from "next";
import { Readable } from "stream";
import { getOctokit } from "../lib/github";
import { saveSlackUser } from "../lib/prNotificationsSlack";
import { getS3Client } from "../lib/s3";
import handler from "../pages/api/pr_notifications/slack_events";
import { mockRes } from "./nextApiMocks";

jest.mock("../lib/s3", () => ({ getS3Client: jest.fn() }));
jest.mock("../lib/github", () => ({ getOctokit: jest.fn() }));

const SECRET = "secret";
const CHANNEL = "C0C8N0L7U5Q";
const send = jest.fn();
const fetchMock = jest.fn();
const getByUsername = jest.fn();

// The Slack API method and arguments of each call
function slackCalls() {
  return fetchMock.mock.calls.map(([url, init]) => [
    url.replace("https://slack.com/api/", ""),
    JSON.parse(init.body),
  ]);
}

function gitHubError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

function saved(users: Record<string, string>, etag = '"1"') {
  return {
    Body: { transformToString: async () => JSON.stringify(users) },
    ETag: etag,
  };
}

function s3Error(name: string, status: number) {
  return Object.assign(new Error(name), {
    name,
    $metadata: { httpStatusCode: status },
  });
}

function writes() {
  return send.mock.calls
    .map(([command]) => command)
    .filter((command) => command instanceof PutObjectCommand)
    .map(({ input }) => ({
      users: JSON.parse(input.Body as string),
      IfMatch: input.IfMatch,
      IfNoneMatch: input.IfNoneMatch,
    }));
}

function slackRequest(
  payload: any,
  { secret = SECRET, age = 0, headers = {} as Record<string, string> } = {}
) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000) - age);
  const hmac = createHmac("sha256", secret).update(`v0:${timestamp}:${body}`);
  return Object.assign(Readable.from([body]), {
    method: "POST",
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${hmac.digest("hex")}`,
      ...headers,
    },
  }) as unknown as NextApiRequest;
}

async function post(req: NextApiRequest) {
  const res = mockRes();
  await handler(req, res);
  return res;
}

function message(text: string, extra: Record<string, string> = {}) {
  return {
    type: "event_callback",
    event: {
      type: "message",
      channel: CHANNEL,
      user: "UA",
      text,
      ts: "1.1",
      ...extra,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PYTORCH_SLACK_SIGNING_SECRET = SECRET;
  (getS3Client as jest.Mock).mockReturnValue({ send });
  (getOctokit as jest.Mock).mockResolvedValue({
    rest: { users: { getByUsername } },
  });
  getByUsername.mockImplementation(async ({ username }) => ({
    data: { login: username, type: "User" },
  }));
  global.fetch = fetchMock;
  fetchMock.mockResolvedValue({ json: async () => ({ ok: true }) });
});

describe("/api/pr_notifications/slack_events", () => {
  it("rejects a bad signature or an old request", async () => {
    const bad = await post(slackRequest(message("github: a"), { secret: "x" }));
    const old = await post(slackRequest(message("github: a"), { age: 600 }));
    expect([bad._status, old._status]).toEqual([403, 403]);
    expect(send).not.toHaveBeenCalled();
  });

  it("answers the URL verification challenge", async () => {
    const res = await post(
      slackRequest({ type: "url_verification", challenge: "c" })
    );
    expect(res._json).toEqual({ challenge: "c" });
  });

  it("saves an existing GitHub account, then confirms it", async () => {
    send.mockResolvedValueOnce(saved({}));
    getByUsername.mockResolvedValueOnce({
      data: { login: "Alice-2", type: "User" },
    });
    const res = await post(slackRequest(message("GitHub: @alice-2")));
    expect(res._status).toBe(200);
    expect(getByUsername).toHaveBeenCalledWith({ username: "alice-2" });
    expect(writes()[0].users).toEqual({ UA: "alice-2" });
    expect(slackCalls()).toEqual([
      [
        "reactions.add",
        { channel: CHANNEL, timestamp: "1.1", name: "white_check_mark" },
      ],
    ]);
  });

  it("tells the poster when the GitHub account can't be found", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    for (const lookup of [
      () => getByUsername.mockRejectedValueOnce(gitHubError(404)),
      () =>
        getByUsername.mockResolvedValueOnce({
          data: { login: "pytorch", type: "Organization" },
        }),
      // A failed lookup gets the same reply, so the member posts again
      () => getByUsername.mockRejectedValueOnce(gitHubError(502)),
    ]) {
      fetchMock.mockClear();
      lookup();
      const res = await post(slackRequest(message("github: pytorch")));
      expect(res._status).toBe(200);
      expect(slackCalls()).toEqual([
        ["reactions.add", { channel: CHANNEL, timestamp: "1.1", name: "x" }],
        [
          "chat.postEphemeral",
          {
            channel: CHANNEL,
            user: "UA",
            text: expect.stringContaining("named `pytorch`"),
          },
        ],
      ]);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("skips Slack's resend of an event that is still being handled", async () => {
    const res = await post(
      slackRequest(message("github: alice"), {
        headers: {
          "x-slack-retry-num": "1",
          "x-slack-retry-reason": "http_timeout",
        },
      })
    );
    expect(res._status).toBe(200);
    expect(getByUsername).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores everything else", async () => {
    for (const payload of [
      message("github: alice and more"),
      message("my github: alice"),
      message("github: alice", { channel: "C1" }),
      message("github: alice", { subtype: "message_changed" }),
    ]) {
      expect((await post(slackRequest(payload)))._status).toBe(200);
    }
    expect(getByUsername).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails when the reaction fails, so Slack retries", async () => {
    send.mockResolvedValueOnce(saved({}));
    fetchMock.mockResolvedValue({
      json: async () => ({ ok: false, error: "missing_scope" }),
    });
    await expect(post(slackRequest(message("github: alice")))).rejects.toThrow(
      "missing_scope"
    );
  });
});

describe("saveSlackUser", () => {
  it("adds to the saved mapping, unless it changed since the read", async () => {
    send.mockResolvedValueOnce(saved({ UB: "bob" }));
    await saveSlackUser("UA", "alice");
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetObjectCommand);
    expect(writes()).toEqual([
      { users: { UA: "alice", UB: "bob" }, IfMatch: '"1"' },
    ]);
  });

  it("creates the mapping, unless it was created since the read", async () => {
    send.mockRejectedValueOnce(s3Error("NoSuchKey", 404));
    await saveSlackUser("UA", "alice");
    expect(writes()).toEqual([{ users: { UA: "alice" }, IfNoneMatch: "*" }]);
  });

  it("retries a conflicting write against the newer mapping", async () => {
    send
      .mockResolvedValueOnce(saved({}, '"1"'))
      .mockRejectedValueOnce(s3Error("PreconditionFailed", 412))
      .mockResolvedValueOnce(saved({ UB: "bob" }, '"2"'));
    await saveSlackUser("UA", "alice");
    expect(writes().map((w) => w.IfMatch)).toEqual(['"1"', '"2"']);
    expect(writes()[1].users).toEqual({ UA: "alice", UB: "bob" });
  });

  it("fails instead of overwriting when the read fails", async () => {
    send.mockRejectedValueOnce(s3Error("AccessDenied", 403));
    await expect(saveSlackUser("UA", "alice")).rejects.toThrow("AccessDenied");
    expect(writes()).toEqual([]);
  });
});
