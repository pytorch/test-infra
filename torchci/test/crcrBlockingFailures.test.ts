import PytorchBotHandler, {
  PytorchbotParams,
} from "../lib/bot/pytorchBotHandler";
import { clearAllowlistCache } from "../lib/crcrAllowlist";

const VALID_ALLOWLIST_YAML = `
L3:
  xpu:
    intel/torch-xpu-ops: [oncall_xpu]
L4:
  - apple/mps-backend: [oncall_mps]
  - nvidia/cuda-deep: [oncall_cuda]
`;

/** Base64-encode a string (Node.js Buffer → base64). */
function toBase64(s: string): string {
  return Buffer.from(s).toString("base64");
}

function makeHandler(
  overrides: Partial<PytorchbotParams> = {}
): PytorchBotHandler {
  const params: PytorchbotParams = {
    owner: "pytorch",
    repo: "pytorch",
    prNum: 42,
    ctx: {
      octokit: {
        paginate: jest.fn(),
        pulls: { get: jest.fn() },
        checks: { listForRef: jest.fn() },
        rest: {
          repos: {
            getContent: jest.fn().mockResolvedValue({
              data: { content: toBase64(VALID_ALLOWLIST_YAML) },
            }),
          },
        },
      },
      log: jest.fn(),
    },
    url: "https://github.com/pytorch/pytorch/pull/42#issuecomment-123",
    login: "test-user",
    commentId: 123,
    commentBody: "@pytorchbot merge",
    useReactions: false,
    cachedConfigTracker: {} as any,
    ...overrides,
  };
  const handler = new PytorchBotHandler(params);
  // Pre-set headSha to avoid the ensureHeadSha() → octokit.pulls.get call
  handler.headSha = "abc123def";
  return handler;
}

describe("getCrcrBlockingFailures", () => {
  beforeEach(() => {
    clearAllowlistCache();
  });

  test("returns [] when there are no CRCR check runs", async () => {
    const handler = makeHandler();
    handler.ctx.octokit.paginate.mockResolvedValue([
      { name: "some-other-check", status: "completed", conclusion: "failure" },
    ]);

    const result = await handler.getCrcrBlockingFailures();
    expect(result).toEqual([]);
  });

  test("returns L4 repo name when an L4 check run has failed", async () => {
    const handler = makeHandler();
    handler.ctx.octokit.paginate.mockResolvedValue([
      {
        name: "crcr/apple/mps-backend/CI/build",
        status: "completed",
        conclusion: "failure",
      },
    ]);

    const result = await handler.getCrcrBlockingFailures();
    expect(result).toEqual(["apple/mps-backend"]);
  });

  test("does NOT return L3 repo when an L3 check run has failed", async () => {
    const handler = makeHandler();
    handler.ctx.octokit.paginate.mockResolvedValue([
      {
        name: "crcr/intel/torch-xpu-ops/CI/build",
        status: "completed",
        conclusion: "failure",
      },
    ]);

    const result = await handler.getCrcrBlockingFailures();
    expect(result).toEqual([]);
  });

  test("returns L4 repo when an L4 check run is still pending", async () => {
    const handler = makeHandler();
    handler.ctx.octokit.paginate.mockResolvedValue([
      {
        name: "crcr/apple/mps-backend/CI/build",
        status: "in_progress",
        conclusion: null,
      },
    ]);

    const result = await handler.getCrcrBlockingFailures();
    expect(result).toEqual(["apple/mps-backend"]);
  });

  test("does NOT return L4 repo when L4 check run has succeeded", async () => {
    const handler = makeHandler();
    handler.ctx.octokit.paginate.mockResolvedValue([
      {
        name: "crcr/apple/mps-backend/CI/build",
        status: "completed",
        conclusion: "success",
      },
    ]);

    const result = await handler.getCrcrBlockingFailures();
    expect(result).toEqual([]);
  });

  test("cancelled/timed_out L4 does NOT block merge", async () => {
    const handler = makeHandler();
    handler.ctx.octokit.paginate.mockResolvedValue([
      {
        name: "crcr/apple/mps-backend/CI/build",
        status: "completed",
        conclusion: "cancelled",
      },
      {
        name: "crcr/apple/mps-backend/CI/test",
        status: "completed",
        conclusion: "timed_out",
      },
    ]);

    const result = await handler.getCrcrBlockingFailures();
    expect(result).toEqual([]);
  });

  test("fails open when checks.listForRef throws", async () => {
    const handler = makeHandler();
    handler.ctx.octokit.paginate.mockRejectedValue(new Error("API error"));

    const result = await handler.getCrcrBlockingFailures();
    expect(result).toEqual([]);
  });

  test("fails open when ensureHeadSha throws (headSha not preset)", async () => {
    const handler = makeHandler();
    handler.headSha = undefined; // force ensureHeadSha → pulls.get call
    handler.ctx.octokit.pulls.get.mockRejectedValue(
      new Error("transient pull fetch error")
    );

    const result = await handler.getCrcrBlockingFailures();
    expect(result).toEqual([]);
  });

  test("fails open when allowlist fetch throws", async () => {
    const handler = makeHandler();
    handler.ctx.octokit.rest.repos.getContent.mockRejectedValue(
      new Error("allowlist fetch error")
    );
    handler.ctx.octokit.paginate.mockResolvedValue([
      {
        name: "crcr/apple/mps-backend/CI/build",
        status: "completed",
        conclusion: "failure",
      },
    ]);

    const result = await handler.getCrcrBlockingFailures();
    expect(result).toEqual([]);
  });

  test("deduplicates repos with multiple failed/pending check runs", async () => {
    const handler = makeHandler();
    handler.ctx.octokit.paginate.mockResolvedValue([
      {
        name: "crcr/apple/mps-backend/CI/build",
        status: "completed",
        conclusion: "failure",
      },
      {
        name: "crcr/apple/mps-backend/CI/test",
        status: "in_progress",
        conclusion: null,
      },
    ]);

    const result = await handler.getCrcrBlockingFailures();
    expect(result).toEqual(["apple/mps-backend"]);
  });

  test("returns multiple distinct L4 repos when both have failures", async () => {
    const handler = makeHandler();
    handler.ctx.octokit.paginate.mockResolvedValue([
      {
        name: "crcr/apple/mps-backend/CI/build",
        status: "completed",
        conclusion: "failure",
      },
      {
        name: "crcr/nvidia/cuda-deep/CI/test",
        status: "in_progress",
        conclusion: null,
      },
    ]);

    const result = await handler.getCrcrBlockingFailures();
    expect(result.sort()).toEqual(
      ["apple/mps-backend", "nvidia/cuda-deep"].sort()
    );
  });

  test("ignores non-CRCR failures for known L4 repos", async () => {
    const handler = makeHandler();
    handler.ctx.octokit.paginate.mockResolvedValue([
      {
        name: "apple/mps-backend/CI", // no crcr/ prefix
        status: "completed",
        conclusion: "failure",
      },
    ]);

    const result = await handler.getCrcrBlockingFailures();
    expect(result).toEqual([]);
  });

  test("only returns allowlisted L4 repos, not unknown CRCR repos", async () => {
    const handler = makeHandler();
    handler.ctx.octokit.paginate.mockResolvedValue([
      {
        name: "crcr/unknown/repo/CI/build",
        status: "completed",
        conclusion: "failure",
      },
    ]);

    const result = await handler.getCrcrBlockingFailures();
    expect(result).toEqual([]);
  });
});
