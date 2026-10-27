import { authorizeGithubToken } from "lib/auth/githubAuth";
import * as github from "lib/github";

// The shared HUD GitHub gate's verdicts, with GitHub played by a stub octokit:
// a token GitHub refuses is the caller's 401, not a 500 of ours.

function octokitStub({
  login,
  permission,
  failure,
  lookupFailure,
}: {
  login?: string;
  permission?: string;
  // Thrown by the identity call.
  failure?: unknown;
  // Thrown by the permission lookup.
  lookupFailure?: unknown;
}) {
  return {
    rest: {
      users: {
        getAuthenticated: jest.fn(async () => {
          if (failure !== undefined) throw failure;
          return { data: { login } };
        }),
      },
      repos: {
        getCollaboratorPermissionLevel: jest.fn(async () => {
          if (lookupFailure !== undefined) throw lookupFailure;
          return { data: { permission } };
        }),
      },
    },
  } as unknown as Awaited<ReturnType<typeof github.getOctokitWithUserToken>>;
}

describe("authorizeGithubToken", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("admits a user with write access", async () => {
    jest
      .spyOn(github, "getOctokitWithUserToken")
      .mockResolvedValue(octokitStub({ login: "writer", permission: "write" }));
    expect(await authorizeGithubToken("token")).toEqual({
      ok: true,
      login: "writer",
    });
  });

  test("refuses a user with read access with 403", async () => {
    jest
      .spyOn(github, "getOctokitWithUserToken")
      .mockResolvedValue(octokitStub({ login: "reader", permission: "read" }));
    expect(await authorizeGithubToken("token")).toEqual({
      ok: false,
      status: 403,
      error: "Write permissions to pytorch/pytorch repository required",
    });
  });

  test.each([
    [
      "a 403 for lacking push access",
      Object.assign(
        new Error("Must have push access to view collaborator permission"),
        {
          status: 403,
          response: { headers: { "x-ratelimit-remaining": "4999" } },
        }
      ),
    ],
    ["a 404", Object.assign(new Error("Not Found"), { status: 404 })],
  ])(
    "GitHub refusing the permission lookup with %s is the user's 403",
    async (_name, lookupFailure) => {
      jest
        .spyOn(github, "getOctokitWithUserToken")
        .mockResolvedValue(octokitStub({ login: "outsider", lookupFailure }));
      const error = jest.spyOn(console, "error").mockImplementation(() => {});
      expect(await authorizeGithubToken("token")).toEqual({
        ok: false,
        status: 403,
        error: "Write permissions to pytorch/pytorch repository required",
      });
      expect(error).not.toHaveBeenCalled();
    }
  );

  test("a rate limit on the permission lookup is still 503", async () => {
    jest.spyOn(github, "getOctokitWithUserToken").mockResolvedValue(
      octokitStub({
        login: "someone",
        lookupFailure: Object.assign(new Error("API rate limit exceeded"), {
          status: 403,
          response: {
            headers: { "x-ratelimit-remaining": "0", "retry-after": "5" },
          },
        }),
      })
    );
    jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(await authorizeGithubToken("token")).toMatchObject({
      ok: false,
      status: 503,
      retryAfterSeconds: 5,
    });
  });

  test("any other failure of the permission lookup is still 500, logged", async () => {
    jest.spyOn(github, "getOctokitWithUserToken").mockResolvedValue(
      octokitStub({
        login: "someone",
        lookupFailure: Object.assign(new Error("Bad Gateway"), { status: 502 }),
      })
    );
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(await authorizeGithubToken("token")).toEqual({
      ok: false,
      status: 500,
      error: "Permission check failed",
    });
    expect(error).toHaveBeenCalledTimes(1);
  });

  test("a token GitHub refuses is 401", async () => {
    jest.spyOn(github, "getOctokitWithUserToken").mockResolvedValue(
      octokitStub({
        failure: Object.assign(new Error("Bad credentials"), { status: 401 }),
      })
    );
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(await authorizeGithubToken("token")).toEqual({
      ok: false,
      status: 401,
      error: "GitHub authentication failed",
    });
    expect(error).not.toHaveBeenCalled();
  });

  test.each([
    [
      "a 429 with Retry-After",
      {
        status: 429,
        message: "Too Many Requests",
        headers: { "retry-after": "17" },
      },
      17,
    ],
    [
      "a 403 with the primary limit spent",
      {
        status: 403,
        message: "API rate limit exceeded for 1.2.3.4.",
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 90),
        },
      },
      90,
    ],
    [
      "a 403 naming the secondary limit",
      {
        status: 403,
        message: "You have exceeded a secondary rate limit.",
        headers: {},
      },
      60,
    ],
  ])(
    "GitHub rate limiting HUD, %s, is 503 with seconds to wait",
    async (_name, { status, message, headers }, retryAfterSeconds) => {
      jest.spyOn(github, "getOctokitWithUserToken").mockResolvedValue(
        octokitStub({
          failure: Object.assign(new Error(message), {
            status,
            response: { headers },
          }),
        })
      );
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      const error = jest.spyOn(console, "error").mockImplementation(() => {});
      const verdict = await authorizeGithubToken("token");
      expect(verdict).toMatchObject({
        ok: false,
        status: 503,
        error: "GitHub is rate limiting HUD; retry later",
      });
      const seconds = (verdict as { retryAfterSeconds?: number })
        .retryAfterSeconds;
      expect(seconds).toBeGreaterThanOrEqual(retryAfterSeconds - 2);
      expect(seconds).toBeLessThanOrEqual(retryAfterSeconds);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(error).not.toHaveBeenCalled();
    }
  );

  test("a 403 that is not a rate limit is still 500, logged", async () => {
    jest.spyOn(github, "getOctokitWithUserToken").mockResolvedValue(
      octokitStub({
        failure: Object.assign(
          new Error("Resource protected by organization SAML enforcement."),
          {
            status: 403,
            response: { headers: { "x-ratelimit-remaining": "4999" } },
          }
        ),
      })
    );
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(await authorizeGithubToken("token")).toEqual({
      ok: false,
      status: 500,
      error: "Permission check failed",
    });
    expect(error).toHaveBeenCalledTimes(1);
  });

  test("GitHub failing otherwise is 500, logged", async () => {
    jest.spyOn(github, "getOctokitWithUserToken").mockResolvedValue(
      octokitStub({
        failure: Object.assign(new Error("Service Unavailable"), {
          status: 503,
        }),
      })
    );
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(await authorizeGithubToken("token")).toEqual({
      ok: false,
      status: 500,
      error: "Permission check failed",
    });
    expect(error).toHaveBeenCalledTimes(1);
  });
});
