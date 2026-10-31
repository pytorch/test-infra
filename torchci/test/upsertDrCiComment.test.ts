import { RecentWorkflowsData } from "lib/types";
import { notifiedHandles, renderCrcrSection } from "../lib/crcr/crcrComment";
import * as drciUtils from "../lib/drciUtils";
import { formDrciComment } from "../lib/drciUtils";

// upsertDrCiComment reads the active sevs before rebuilding the comment; the
// rebuild is what this file is about, so the lookup is stubbed out.
jest.mock("../lib/fetchIssuesByLabel", () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue([]),
}));

function crcrJob(): RecentWorkflowsData {
  return {
    name: "crcr/pytorch/crcr-test/CRCR L3 CI/test-L3-checkrun-creation",
    jobName: "test-L3-checkrun-creation",
    workflowId: 0,
    workflowUniqueId: 0,
    id: 999,
    completed_at: "2023-08-08 06:03:21",
    html_url: "https://github.com/pytorch/crcr-test/actions/runs/555",
    head_sha: "abcdef1234567890",
    head_sha_timestamp: "",
    head_branch: "",
    pr_number: 123,
    conclusion: "failure",
    failure_captures: [],
    failure_lines: [],
    failure_context: [],
    downstreamLevel: "L3",
    downstreamRepo: "pytorch/crcr-test",
    runAttempt: 1,
  };
}

function octokitFor(body: string) {
  return {
    rest: {
      issues: {
        listComments: jest.fn().mockResolvedValue({
          data: [{ id: 456, body, user: { login: "pytorch-bot[bot]" } }],
        }),
      },
    },
    // getDrciComment reads through `octokit.rest.issues` while the upsert writes
    // through the legacy shorthand `context.octokit.issues`.
    issues: {
      updateComment: jest.fn(),
      createComment: jest.fn(),
    },
  } as any;
}

describe("upsertDrCiComment", () => {
  test("keeps the CRCR pins but not the blocks a push may have invalidated", async () => {
    const section = renderCrcrSection(
      new Map([["pytorch/crcr-test", [crcrJob()]]]),
      new Map([["pytorch/crcr-test", 2]]),
      "https://hud.pytorch.org/pr/pytorch/pytorch/123",
      () => ["alice"],
      new Map()
    );
    const existing = formDrciComment(123, "pytorch", "pytorch", section);
    expect(notifiedHandles(existing)).toEqual(new Set(["alice"]));

    const octokit = octokitFor(existing);
    await drciUtils.upsertDrCiComment(
      "pytorch",
      "pytorch",
      123,
      { octokit, log: jest.fn(), payload: {} } as any,
      "https://github.com/pytorch/pytorch/pull/123"
    );

    expect(octokit.issues.updateComment).toHaveBeenCalledTimes(1);
    const rewritten = octokit.issues.updateComment.mock.calls[0][0].body;

    // The markers are the only record that alice has been paged, so they have
    // to survive the rewrite; without them the next sweep mentions her again.
    expect(notifiedHandles(rewritten)).toEqual(new Set(["alice"]));
    // The blocks do not: this rewrite is triggered by a push, which may have
    // fixed the failure, and the next sweep renders the real section.
    expect(rewritten).not.toContain("<details>");
    expect(rewritten).not.toContain("@alice");
  });

  test("writes the comment untouched when there was no CRCR section", async () => {
    const existing = formDrciComment(123, "pytorch", "pytorch", "## results");
    const octokit = octokitFor(existing);

    await drciUtils.upsertDrCiComment(
      "pytorch",
      "pytorch",
      123,
      { octokit, log: jest.fn(), payload: {} } as any,
      "https://github.com/pytorch/pytorch/pull/123"
    );

    const rewritten = octokit.issues.updateComment.mock.calls[0][0].body;
    expect(rewritten).not.toContain("crcr-section");
    expect(rewritten).not.toContain("crcr-pinned");
  });
});
