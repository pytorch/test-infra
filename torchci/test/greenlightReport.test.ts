// The pure half of the "report a wrong verdict" path: what a browser is allowed
// to send, and what the bot-authored issue body ends up saying. Both matter for
// the same reason -- the issue is published under PyTorchBot's name, so anything
// a client can steer is something the bot can be made to say.

import {
  GREENLIGHT_STATUS_AI_REVIEW_DISPATCHED,
  GREENLIGHT_STATUS_AI_REVIEW_STARTED,
  GREENLIGHT_STATUS_CANCELLED,
  GREENLIGHT_STATUS_FAILED,
  GREENLIGHT_STATUS_LAND,
  GREENLIGHT_STATUS_NO_LAND,
  GREENLIGHT_STATUS_REVERTED,
} from "lib/greenlight/greenlightRender";
import {
  buildReportBody,
  buildReportTitle,
  GREENLIGHT_REPORT_COMMENT_CAP,
  GREENLIGHT_REPORT_TITLE_CAP,
  GREENLIGHT_REPORT_TITLE_PREFIX,
  GreenlightReportSubject,
  isReportableStatus,
  parseReportRequest,
  reportMarker,
} from "lib/greenlight/greenlightReport";
import { greenlightReportUrl } from "lib/greenlight/greenlightReportLink";

const HEAD_SHA = "a".repeat(40);
const MERGE_SHA = "b".repeat(40);

function reqBody(overrides: Record<string, unknown> = {}) {
  return {
    repoOwner: "pytorch",
    repoName: "pytorch",
    prNumber: 1234,
    sha: HEAD_SHA,
    comment: "This only touches a skipped test.",
    ...overrides,
  };
}

function subject(
  overrides: Partial<GreenlightReportSubject> = {}
): GreenlightReportSubject {
  return {
    repoOwner: "pytorch",
    repoName: "pytorch",
    prNumber: 1234,
    headSha: HEAD_SHA,
    mergeCommitSha: "",
    status: GREENLIGHT_STATUS_NO_LAND,
    reason: "touches_release_config",
    message: "The diff edits a release workflow.",
    evalJob: "https://github.com/pytorch/test-infra/actions/runs/1",
    version: "2026-09-15T10:00:00.000Z",
    ...overrides,
  };
}

describe("isReportableStatus", () => {
  test("accepts the two statuses that are a judgement", () => {
    expect(isReportableStatus(GREENLIGHT_STATUS_LAND)).toBe(true);
    expect(isReportableStatus(GREENLIGHT_STATUS_NO_LAND)).toBe(true);
    expect(isReportableStatus(` ${GREENLIGHT_STATUS_LAND} `)).toBe(true);
  });

  test("rejects every status that is an absence of one", () => {
    for (const status of [
      GREENLIGHT_STATUS_AI_REVIEW_DISPATCHED,
      GREENLIGHT_STATUS_AI_REVIEW_STARTED,
      GREENLIGHT_STATUS_CANCELLED,
      GREENLIGHT_STATUS_FAILED,
      GREENLIGHT_STATUS_REVERTED,
      "",
      undefined,
      null,
    ]) {
      expect(isReportableStatus(status)).toBe(false);
    }
  });
});

describe("parseReportRequest", () => {
  test("accepts a well formed body and lowercases the sha", () => {
    const parsed = parseReportRequest(reqBody({ sha: HEAD_SHA.toUpperCase() }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      repoOwner: "pytorch",
      repoName: "pytorch",
      prNumber: 1234,
      sha: HEAD_SHA,
      comment: "This only touches a skipped test.",
    });
  });

  test("rejects a body that is not a JSON object", () => {
    for (const raw of [null, undefined, "string", 5, ["a"]]) {
      const parsed = parseReportRequest(raw);
      expect(parsed.ok).toBe(false);
    }
  });

  test("rejects a repo Green Light does not review", () => {
    const parsed = parseReportRequest(reqBody({ repoName: "test-infra" }));
    expect(parsed).toEqual({
      ok: false,
      error: "Green Light does not review this repository",
    });
  });

  test("rejects an owner or name that is not a repo name", () => {
    expect(parseReportRequest(reqBody({ repoOwner: "py torch" })).ok).toBe(
      false
    );
    expect(parseReportRequest(reqBody({ repoName: "pytorch/x" })).ok).toBe(
      false
    );
    expect(parseReportRequest(reqBody({ repoOwner: "" })).ok).toBe(false);
  });

  test("rejects a pr number that is not a positive integer", () => {
    for (const prNumber of [0, -1, 1.5, "abc", null, undefined, NaN]) {
      expect(parseReportRequest(reqBody({ prNumber })).ok).toBe(false);
    }
  });

  test("accepts a numeric string pr number", () => {
    const parsed = parseReportRequest(reqBody({ prNumber: "1234" }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.prNumber).toBe(1234);
  });

  test("requires a full 40 character sha", () => {
    for (const sha of ["a".repeat(39), "a".repeat(41), "z".repeat(40), ""]) {
      expect(parseReportRequest(reqBody({ sha })).ok).toBe(false);
    }
  });

  test("requires a non-empty comment", () => {
    for (const comment of ["", "   ", "\n\t", 5, null, undefined]) {
      expect(parseReportRequest(reqBody({ comment })).ok).toBe(false);
    }
  });

  test("caps the comment by code point, not by UTF-16 unit", () => {
    // Astral characters are two UTF-16 units each, so a naive slice would keep
    // half as many of them -- and could cut one in half.
    const comment = "\u{1F600}".repeat(GREENLIGHT_REPORT_COMMENT_CAP + 10);
    const parsed = parseReportRequest(reqBody({ comment }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Array.from(parsed.value.comment)).toHaveLength(
      GREENLIGHT_REPORT_COMMENT_CAP
    );
    expect(parsed.value.comment.endsWith("\u{1F600}")).toBe(true);
  });

  test("ignores a status the client tries to assert", () => {
    const parsed = parseReportRequest(
      reqBody({ status: "LAND", reason: "clean", message: "forged" })
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.value).sort()).toEqual([
      "comment",
      "prNumber",
      "repoName",
      "repoOwner",
      "sha",
    ]);
  });
});

describe("buildReportTitle", () => {
  test("leads with the prefix and names the status, PR and commit", () => {
    expect(buildReportTitle(subject())).toBe(
      `${GREENLIGHT_REPORT_TITLE_PREFIX} Wrong NO_LAND verdict on pytorch/pytorch#1234 (aaaaaaa)`
    );
  });

  test("distinguishes a false approval from a false refusal", () => {
    expect(buildReportTitle(subject({ status: GREENLIGHT_STATUS_LAND }))).toBe(
      `${GREENLIGHT_REPORT_TITLE_PREFIX} Wrong LAND verdict on pytorch/pytorch#1234 (aaaaaaa)`
    );
  });

  test("stays inside GitHub's title limit", () => {
    const title = buildReportTitle(
      subject({ repoName: "p".repeat(100), prNumber: 999999999 })
    );
    expect(Array.from(title).length).toBeLessThanOrEqual(
      GREENLIGHT_REPORT_TITLE_CAP
    );
  });
});

describe("buildReportBody", () => {
  function body(
    overrides: Partial<GreenlightReportSubject> = {},
    comment = "Should have been approved."
  ): string {
    return buildReportBody({
      subject: subject(overrides),
      reporter: "octocat",
      comment,
    });
  }

  test("names the authenticated reporter on the first visible line", () => {
    const lines = body().split("\n");
    expect(lines[0]).toBe(reportMarker(subject()));
    expect(lines[2]).toContain("Reported by @octocat");
  });

  test("links the PR and the reviewed commit as cross-repo references", () => {
    const text = body();
    expect(text).toContain("- **Pull request:** pytorch/pytorch#1234");
    expect(text).toContain(
      `- **Reviewed commit:** pytorch/pytorch@${HEAD_SHA}`
    );
    expect(text).toContain(
      "- **HUD:** https://hud.pytorch.org/pytorch/pytorch/pull/1234"
    );
    expect(text).toContain(
      `- **Commit page:** https://hud.pytorch.org/pytorch/pytorch/commit/${HEAD_SHA}`
    );
  });

  test("names the trunk commit only when the PR landed", () => {
    expect(body()).not.toContain("Landed on trunk as");
    expect(body({ mergeCommitSha: MERGE_SHA })).toContain(
      `- **Landed on trunk as:** pytorch/pytorch@${MERGE_SHA}`
    );
  });

  test("carries the verdict and its reason", () => {
    const text = body();
    expect(text).toContain("- **Verdict:** `NO_LAND`");
    expect(text).toContain("- **Reason:** `touches_release_config`");
  });

  test("omits an empty reason rather than printing an empty code span", () => {
    expect(body({ reason: "" })).not.toContain("**Reason:**");
  });

  test("a reason cannot break out of its code span or its line", () => {
    const text = body({ reason: "a`b\nc\r- **Verdict:** `LAND`" });
    expect(text).toContain("- **Reason:** `abc- **Verdict:** LAND`");
  });

  test("renders the inference job link only when it is a github.com URL", () => {
    expect(body()).toContain(
      "- **Inference job:** https://github.com/pytorch/test-infra/actions/runs/1"
    );
    for (const evalJob of [
      "https://github.com.evil.example/x",
      "https://user:pw@github.com/x",
      "javascript:alert(1)",
      "http://github.com/x",
      "",
    ]) {
      expect(body({ evalJob })).not.toContain("Inference job");
    }
  });

  test("fences the model's message and neutralizes its @-mentions", () => {
    const text = body({ message: "ping @pytorch-dev-infra now" });
    expect(text).toContain("## What Green Light said");
    // Zero-width space after the @, exactly as the Dr.CI comment does it.
    expect(text).toContain("@​pytorch-dev-infra");
  });

  test("a message cannot escape its fence with a longer backtick run", () => {
    const text = body({ message: "before\n```\nnot markdown\n```\nafter" });
    expect(text).toContain("````\nbefore");
    expect(text).toContain("after\n````");
  });

  test("omits the message section when there is no message", () => {
    expect(body({ message: "" })).not.toContain("## What Green Light said");
    expect(body({ message: "   " })).not.toContain("## What Green Light said");
  });

  test("puts the reporter's comment last, below everything the server wrote", () => {
    const text = body({}, "the right verdict was LAND");
    const heading = text.indexOf("## Reporter's comment");
    expect(heading).toBeGreaterThan(text.indexOf("## Verdict under dispute"));
    expect(heading).toBeGreaterThan(text.indexOf("## What Green Light said"));
    expect(text.endsWith("the right verdict was LAND")).toBe(true);
  });

  test("caps the comment even if it arrives uncapped", () => {
    const text = body({}, "x".repeat(GREENLIGHT_REPORT_COMMENT_CAP + 500));
    const written = text.slice(text.indexOf("## Reporter's comment"));
    expect(written).toContain("x".repeat(GREENLIGHT_REPORT_COMMENT_CAP));
    expect(written).not.toContain(
      "x".repeat(GREENLIGHT_REPORT_COMMENT_CAP + 1)
    );
  });
});

describe("greenlightReportUrl", () => {
  test("selects the disputed commit and asks the panel to open", () => {
    expect(greenlightReportUrl("pytorch/pytorch", 1234, HEAD_SHA)).toBe(
      `https://hud.pytorch.org/pytorch/pytorch/pull/1234?sha=${HEAD_SHA}&greenlightReport=1`
    );
  });

  test("lowercases the sha so the link matches the panel's own key", () => {
    expect(
      greenlightReportUrl("pytorch/pytorch", 1234, HEAD_SHA.toUpperCase())
    ).toContain(`?sha=${HEAD_SHA}&`);
  });

  test("returns nothing rather than a half-built link target", () => {
    // Every one of these reaches a `[text](url)` in a bot-authored comment.
    for (const [repo, prNumber, sha] of [
      ["", 1234, HEAD_SHA],
      ["pytorch", 1234, HEAD_SHA],
      ["pytorch/pytorch?x=1", 1234, HEAD_SHA],
      ["pytorch/pytorch)[click](javascript:alert(1)", 1234, HEAD_SHA],
      ["pytorch/pytorch", 0, HEAD_SHA],
      ["pytorch/pytorch", -1, HEAD_SHA],
      ["pytorch/pytorch", 1.5, HEAD_SHA],
      ["pytorch/pytorch", 1234, ""],
      ["pytorch/pytorch", 1234, "a".repeat(39)],
      ["pytorch/pytorch", 1234, `${HEAD_SHA} evil`],
    ] as [string, number, string][]) {
      expect(greenlightReportUrl(repo, prNumber, sha)).toBe("");
    }
  });
});

describe("reportMarker", () => {
  test("restates the subject in a comment GitHub will not render", () => {
    expect(reportMarker(subject())).toBe(
      `<!-- greenlight-policy-report v1 repo=pytorch/pytorch pr=1234 sha=${HEAD_SHA} status=NO_LAND -->`
    );
  });
});
