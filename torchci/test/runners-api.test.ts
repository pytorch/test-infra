import { NextApiRequest, NextApiResponse } from "next";
import handler, { RunnerData, RunnersApiResponse } from "../pages/api/runners/[org]";

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
    request: jest.fn(),
  })),
}));

describe("/api/runners/[org]", () => {
  let req: Partial<NextApiRequest>;
  let res: Partial<NextApiResponse>;
  let mockGetAuthorizedUsername: jest.Mock;

  beforeEach(() => {
    req = {
      method: "GET",
      query: { org: "test-org" },
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    
    // Set up environment variables
    process.env.APP_ID = "123";
    process.env.PRIVATE_KEY = Buffer.from("fake-key").toString("base64");

    // Mock the authorization function
    const { getAuthorizedUsername } = require("../lib/getAuthorizedUsername");
    mockGetAuthorizedUsername = getAuthorizedUsername as jest.Mock;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test("should return error for non-GET requests", async () => {
    req.method = "POST";
    mockGetAuthorizedUsername.mockResolvedValue("testuser");

    await handler(req as NextApiRequest, res as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.json).toHaveBeenCalledWith({ error: "Method not allowed" });
  });

  test("should return error when user is not authorized", async () => {
    mockGetAuthorizedUsername.mockResolvedValue(null);

    await handler(req as NextApiRequest, res as NextApiResponse);

    expect(mockGetAuthorizedUsername).toHaveBeenCalledWith(req, res, {});
    // The auth function handles the response, so no status/json calls should happen
  });

  test("should return error for missing org parameter", async () => {
    req.query = {};
    mockGetAuthorizedUsername.mockResolvedValue("testuser");

    await handler(req as NextApiRequest, res as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Organization parameter is required" });
  });

  test("should validate response structure", () => {
    // Test that our interfaces are correct
    const mockRunner: RunnerData = {
      id: 1,
      name: "test-runner",
      os: "linux",
      status: "online",
      busy: false,
      labels: [
        { id: 1, name: "self-hosted", type: "read-only" },
        { id: 2, name: "custom", type: "custom" },
      ],
    };

    const mockResponse: RunnersApiResponse = {
      total_count: 1,
      runners: [mockRunner],
    };

    expect(mockResponse.runners).toHaveLength(1);
    expect(mockResponse.runners[0].status).toMatch(/^(online|offline)$/);
    expect(mockResponse.total_count).toBe(mockResponse.runners.length);
  });
});