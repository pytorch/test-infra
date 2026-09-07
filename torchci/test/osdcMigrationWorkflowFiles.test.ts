import { getOctokit } from "lib/github";
import type { NextApiRequest, NextApiResponse } from "next";
import handler from "pages/api/osdc_migration/workflow_files";

jest.mock("lib/github", () => ({
  getOctokit: jest.fn(),
}));

const mockedGetOctokit = jest.mocked(getOctokit);

function mockResponse(): NextApiResponse {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
    setHeader: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  res.setHeader.mockReturnValue(res);
  return res as unknown as NextApiResponse;
}

function mockRequest(
  query: NextApiRequest["query"],
  method = "GET"
): NextApiRequest {
  return { method, query } as NextApiRequest;
}

describe("OSDC migration workflow file endpoint", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("rejects requests for repositories outside the tracker", async () => {
    const res = mockResponse();

    await handler(mockRequest({ repo: "pytorch/test-infra" }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockedGetOctokit).not.toHaveBeenCalled();
  });

  test("rejects repeated and unexpected query parameters", async () => {
    const repeatedRes = mockResponse();
    await handler(
      mockRequest({ repo: ["pytorch/pytorch", "pytorch/vision"] }),
      repeatedRes
    );

    expect(repeatedRes.status).toHaveBeenCalledWith(400);
    expect(mockedGetOctokit).not.toHaveBeenCalled();

    const unexpectedRes = mockResponse();
    await handler(
      mockRequest({ repo: "pytorch/pytorch", nonce: "cache-buster" }),
      unexpectedRes
    );

    expect(unexpectedRes.status).toHaveBeenCalledWith(400);
    expect(mockedGetOctokit).not.toHaveBeenCalled();
  });

  test("rejects methods other than GET", async () => {
    const res = mockResponse();

    await handler(mockRequest({ repo: "pytorch/pytorch" }, "POST"), res);

    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.setHeader).toHaveBeenCalledWith("Allow", "GET");
    expect(mockedGetOctokit).not.toHaveBeenCalled();
  });

  test("lists workflow files for allowlisted meta-pytorch repositories", async () => {
    const getContent = jest.fn().mockResolvedValue({
      data: [
        {
          type: "file",
          path: ".github/workflows/test.yml",
        },
        {
          type: "file",
          path: ".github/workflows/_reusable.yaml",
        },
        {
          type: "file",
          path: ".github/workflows/README.md",
        },
      ],
    });
    mockedGetOctokit.mockResolvedValue({
      rest: { repos: { getContent } },
    } as any);
    const res = mockResponse();

    await handler(mockRequest({ repo: "meta-pytorch/monarch" }), res);

    expect(mockedGetOctokit).toHaveBeenCalledWith("meta-pytorch", "monarch");
    expect(getContent).toHaveBeenCalledWith({
      owner: "meta-pytorch",
      repo: "monarch",
      path: ".github/workflows",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      repo: "meta-pytorch/monarch",
      truncated: false,
      reusableExcluded: 1,
      allFiles: [
        ".github/workflows/_reusable.yaml",
        ".github/workflows/test.yml",
      ],
      files: [".github/workflows/test.yml"],
    });
  });

  test("does not return internal GitHub errors", async () => {
    mockedGetOctokit.mockRejectedValue(new Error("sensitive GitHub failure"));
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const res = mockResponse();

    await handler(mockRequest({ repo: "meta-pytorch/torchcodec" }), res);

    expect(consoleError).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: "Failed to list workflow files",
    });
    consoleError.mockRestore();
  });
});
