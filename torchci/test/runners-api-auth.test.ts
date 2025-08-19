import { NextApiRequest, NextApiResponse } from "next";
import handler from "../pages/api/runners/[org]";

// Mock the authorization module
jest.mock("../lib/getAuthorizedUsername", () => ({
  getAuthorizedUsername: jest.fn(),
}));

// Mock the auth options
jest.mock("../pages/api/auth/[...nextauth]", () => ({
  authOptions: {},
}));

// Mock the octokit modules
jest.mock("@octokit/auth-app", () => ({
  createAppAuth: jest.fn(),
}));

jest.mock("octokit", () => ({
  App: jest.fn().mockImplementation(() => ({
    octokit: {
      request: jest.fn().mockResolvedValue({
        data: { id: 123 },
      }),
    },
  })),
  Octokit: jest.fn().mockImplementation(() => ({
    request: jest.fn().mockResolvedValue({
      data: {
        runners: [
          {
            id: 1,
            name: "test-runner",
            os: "linux",
            status: "online",
            busy: false,
            labels: [{ id: 1, name: "self-hosted", type: "read-only" }],
          },
        ],
      },
    }),
  })),
}));

describe("/api/runners/[org] Authentication", () => {
  let req: Partial<NextApiRequest>;
  let res: Partial<NextApiResponse>;
  let mockGetAuthorizedUsername: jest.Mock;

  beforeEach(() => {
    req = {
      method: "GET",
      query: { org: "pytorch" },
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    
    // Set up environment variables
    process.env.APP_ID = "123";
    process.env.PRIVATE_KEY = Buffer.from("fake-key").toString("base64");

    // Get the mocked function
    const { getAuthorizedUsername } = require("../lib/getAuthorizedUsername");
    mockGetAuthorizedUsername = getAuthorizedUsername as jest.Mock;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test("should require authentication - reject unauthenticated users", async () => {
    // Simulate unauthorized user
    mockGetAuthorizedUsername.mockResolvedValue(null);

    await handler(req as NextApiRequest, res as NextApiResponse);

    expect(mockGetAuthorizedUsername).toHaveBeenCalledWith(req, res, {});
    // When auth fails, the function returns early and doesn't call other methods
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  test("should allow authenticated users with proper permissions", async () => {
    // Simulate authorized user
    mockGetAuthorizedUsername.mockResolvedValue("testuser");

    await handler(req as NextApiRequest, res as NextApiResponse);

    expect(mockGetAuthorizedUsername).toHaveBeenCalledWith(req, res, {});
    // Should proceed to handle the request normally
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      total_count: 1,
      runners: [
        {
          id: 1,
          name: "test-runner",
          os: "linux",
          status: "online",
          busy: false,
          labels: [{ id: 1, name: "self-hosted", type: "read-only" }],
        },
      ],
    });
  });

  test("should work with bypass user (grafana-bypass-user)", async () => {
    // Simulate bypass user
    mockGetAuthorizedUsername.mockResolvedValue("grafana-bypass-user");

    await handler(req as NextApiRequest, res as NextApiResponse);

    expect(mockGetAuthorizedUsername).toHaveBeenCalledWith(req, res, {});
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalled();
  });
});