/**
 * The Dr. CI endpoint's authorization block, which runs before the handler's
 * own try/catch.
 *
 * Every fault here must still produce a response. One that escapes leaves the
 * function with none and the platform answers 500, and trymerge reads any
 * failure of this call as "no classifications" -- so an escaping fault
 * degrades merges quietly instead of reporting itself.
 */

import { NextApiRequest } from "next";
import * as githubModule from "../lib/github";
import * as rateLimitModule from "../lib/rateLimit";
import handler from "../pages/api/drci/drci";
import { mockRes } from "./nextApiMocks";

jest.mock("../lib/github", () => {
  const actual = jest.requireActual("../lib/github");
  return {
    ...actual,
    getOctokitWithUserToken: jest.fn(),
    getOctokit: jest.fn(),
  };
});

jest.mock("../lib/rateLimit", () => ({
  drCIRateLimitExceeded: jest.fn(),
  incrementDrCIRateLimit: jest.fn(),
}));

const mockGetOctokitWithUserToken =
  githubModule.getOctokitWithUserToken as jest.Mock;
const mockGetOctokit = githubModule.getOctokit as jest.Mock;
const mockRateLimitExceeded =
  rateLimitModule.drCIRateLimitExceeded as jest.Mock;
const mockIncrementRateLimit =
  rateLimitModule.incrementDrCIRateLimit as jest.Mock;

/** Rejecting getOctokit is the cheapest proof the handler body was reached. */
const REACHED_BODY = "reached the handler body";

function mockReq(
  authorization: string | undefined,
  query: Record<string, string> = {}
): NextApiRequest {
  return {
    method: "POST",
    headers: authorization === undefined ? {} : { authorization },
    query,
    body: { repo: "pytorch", org: "pytorch" },
  } as unknown as NextApiRequest;
}

function octokitThatRejects(error: Error) {
  return {
    rest: {
      users: { getAuthenticated: jest.fn().mockRejectedValue(error) },
    },
  };
}

function octokitForLogin(login: string) {
  return {
    rest: {
      users: {
        getAuthenticated: jest.fn().mockResolvedValue({ data: { login } }),
      },
    },
  };
}

/** What Octokit raises when GitHub refuses the token. */
function badCredentials() {
  return Object.assign(new Error("Bad credentials"), { status: 401 });
}

describe("Dr. CI authorization", () => {
  const savedBotKey = process.env.DRCI_BOT_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DRCI_BOT_KEY = "the-bot-key";
    mockRateLimitExceeded.mockResolvedValue(false);
    mockIncrementRateLimit.mockResolvedValue(undefined);
    mockGetOctokit.mockRejectedValue(new Error(REACHED_BODY));
  });

  afterAll(() => {
    if (savedBotKey === undefined) {
      delete process.env.DRCI_BOT_KEY;
    } else {
      process.env.DRCI_BOT_KEY = savedBotKey;
    }
  });

  test("a credential GitHub refuses answers 401, not an unhandled throw", async () => {
    mockGetOctokitWithUserToken.mockResolvedValue(
      octokitThatRejects(badCredentials())
    );
    const res = mockRes();

    await expect(
      handler(
        mockReq("a-key-that-no-longer-matches", { prNumber: "1000" }),
        res
      )
    ).resolves.not.toThrow();

    expect(res._status).toBe(401);
    expect(res._json.error).toBe("Invalid credentials");
    expect(res._headers["WWW-Authenticate"]).toBe("Bearer");
  });

  test("a GitHub fault that is not a refusal answers 503, not 401", async () => {
    // Reaching GitHub at all is this endpoint's problem, not the caller's, so
    // it must not be reported as bad credentials.
    mockGetOctokitWithUserToken.mockResolvedValue(
      octokitThatRejects(new Error("getaddrinfo ENOTFOUND api.github.com"))
    );
    const res = mockRes();

    await handler(mockReq("some-user-token", { prNumber: "1000" }), res);

    expect(res._status).toBe(503);
    expect(res._json.error).toBe("Authentication service unavailable");
  });

  test("a rate-limit read failure answers 503 and leaks no backend detail", async () => {
    mockGetOctokitWithUserToken.mockResolvedValue(octokitForLogin("someone"));
    mockRateLimitExceeded.mockRejectedValue(
      new Error("clickhouse://secret-host:8123 refused the connection")
    );
    const res = mockRes();

    await handler(mockReq("some-user-token", { prNumber: "1000" }), res);

    expect(res._status).toBe(503);
    expect(res._json.error).toBe("Authentication service unavailable");
    expect(JSON.stringify(res._json)).not.toContain("secret-host");
  });

  test("a rate-limit WRITE failure refuses rather than serving unmetered", async () => {
    // The increment used to be neither awaited nor caught, so its rejection
    // escaped as an unhandled one. It is the limit itself, not bookkeeping:
    // serving on a failed insert lets any authenticated user drive unbounded
    // work under the service's bot credentials without consuming quota.
    mockGetOctokitWithUserToken.mockResolvedValue(octokitForLogin("someone"));
    mockIncrementRateLimit.mockRejectedValue(new Error("insert failed"));
    const res = mockRes();

    await handler(mockReq("some-user-token", { prNumber: "1000" }), res);

    expect(mockIncrementRateLimit).toHaveBeenCalledWith("someone");
    expect(res._status).toBe(503);
    expect(mockGetOctokit).not.toHaveBeenCalled();
  });

  test("a factory failure is handled like any other resolution failure", async () => {
    mockGetOctokitWithUserToken.mockRejectedValue(
      new Error("cannot construct")
    );
    const res = mockRes();

    await handler(mockReq("some-user-token", { prNumber: "1000" }), res);

    expect(res._status).toBe(503);
    expect(res._json.error).toBe("Authentication service unavailable");
  });

  test("an upstream 403 is reported as unavailable, not as bad credentials", async () => {
    // GitHub answers 403 for secondary rate limiting and missing scope, which
    // are not "your token is wrong" -- reporting them as 401 is the
    // misdirection this split exists to avoid.
    mockGetOctokitWithUserToken.mockResolvedValue(
      octokitThatRejects(
        Object.assign(new Error("API rate limit exceeded"), { status: 403 })
      )
    );
    const res = mockRes();

    await handler(mockReq("some-user-token", { prNumber: "1000" }), res);

    expect(res._status).toBe(503);
  });

  test("an authenticated user under the limit reaches the handler body", async () => {
    mockGetOctokitWithUserToken.mockResolvedValue(octokitForLogin("someone"));
    const res = mockRes();

    await handler(mockReq("some-user-token", { prNumber: "1000" }), res);

    expect(mockIncrementRateLimit).toHaveBeenCalledWith("someone");
    expect(res._status).toBe(400);
    expect(res._json.error).toContain(REACHED_BODY);
  });

  test("an over-limit user still gets 429", async () => {
    mockGetOctokitWithUserToken.mockResolvedValue(octokitForLogin("someone"));
    mockRateLimitExceeded.mockResolvedValue(true);
    const res = mockRes();

    await handler(mockReq("some-user-token", { prNumber: "1000" }), res);

    expect(res._status).toBe(429);
    // Asserted because 429 answers with .end(): a response that sets a status
    // and never ends leaves the request hanging, which a status-only
    // assertion cannot see.
    expect(res._ended).toBe(true);
    expect(mockIncrementRateLimit).not.toHaveBeenCalled();
  });

  test("a user token without prNumber still gets 403", async () => {
    const res = mockRes();

    await handler(mockReq("some-user-token"), res);

    expect(res._status).toBe(403);
    expect(res._ended).toBe(true);
    expect(mockGetOctokitWithUserToken).not.toHaveBeenCalled();
  });

  test("no Authorization header gets 403", async () => {
    const res = mockRes();

    await handler(mockReq(undefined), res);

    expect(res._status).toBe(403);
    expect(res._ended).toBe(true);
  });

  test("an unset DRCI_BOT_KEY does not admit an anonymous caller as the bot", async () => {
    // undefined == undefined is true, so the bare comparison used to treat
    // every anonymous request as the bot whenever the deployment lost the var.
    delete process.env.DRCI_BOT_KEY;
    const res = mockRes();

    await handler(mockReq(undefined), res);

    expect(res._status).toBe(403);
  });

  test("an empty DRCI_BOT_KEY does not admit an empty Authorization header", async () => {
    process.env.DRCI_BOT_KEY = "";
    const res = mockRes();

    await handler(mockReq(""), res);

    expect(res._status).toBe(403);
    expect(mockGetOctokitWithUserToken).not.toHaveBeenCalled();
  });

  test("the bot key skips the user path and reaches the handler body", async () => {
    const res = mockRes();

    await handler(mockReq("the-bot-key"), res);

    expect(mockGetOctokitWithUserToken).not.toHaveBeenCalled();
    expect(mockRateLimitExceeded).not.toHaveBeenCalled();
    expect(res._status).toBe(400);
    expect(res._json.error).toContain(REACHED_BODY);
  });
});
