import { commitDataFromResponse } from "lib/github";

// The two shapes a landed pytorch/pytorch commit carries its PR number in. The
// HUD reads prNum from here, and every surface that needs a PR -- the PR cell,
// the CRCR lookup, the Green Light mark -- is suppressed when it is null, so a
// shape this misses goes blank rather than wrong.
const GHSTACK_MESSAGE = [
  "[inductor] fold the guard scope (#196818)",
  "",
  "Some body text.",
  "",
  "Pull Request resolved: https://github.com/pytorch/pytorch/pull/196818",
  "Approved by: https://github.com/someone",
].join("\n");

const SQUASH_MESSAGE = [
  "[aot_compile] Resolve a loaded module's guard scope from model.forward (#196818)",
  "",
  "`AOTCompiledModel.deserialize` supplied no guard scope.",
].join("\n");

function response(message: string) {
  return {
    sha: "a".repeat(40),
    html_url: "https://github.com/pytorch/pytorch/commit/" + "a".repeat(40),
    author: { login: "someone", html_url: "https://github.com/someone" },
    commit: {
      message,
      author: { name: "Someone" },
      committer: { date: "2026-09-20T16:31:20Z" },
    },
  };
}

describe("commitDataFromResponse", () => {
  test("reads the PR number from the ghstack trailer", () => {
    expect(commitDataFromResponse(response(GHSTACK_MESSAGE)).prNum).toBe(
      196818
    );
  });

  test("falls back to the number GitHub appends on a squash merge", () => {
    expect(commitDataFromResponse(response(SQUASH_MESSAGE)).prNum).toBe(196818);
  });

  test("a mergebot revert takes no PR number from the title it quotes", () => {
    // Almost every trunk commit with no trailer is one of these, and the number
    // in the subject belongs to the PR being undone, not to this commit. The
    // anchor is what keeps them out: a quoted title ends in a quote, so the
    // suffix is not at the end of the subject. The body names that PR too, in a
    // line the trailer pattern does not match and the suffix never reads.
    const message = [
      'Revert "[native_aot] declaration-driven AOT kernel DispatchStubs (#190897)"',
      "",
      "This reverts commit 818c1044f01038f9da89e400cf8698506ce05e90.",
      "",
      "Reverted https://github.com/pytorch/pytorch/pull/190897 on behalf of",
      "https://github.com/slayton58 due to breaks internal build",
    ].join("\n");
    expect(commitDataFromResponse(response(message)).prNum).toBeNull();
  });

  test("a commit carrying neither shape has no PR number", () => {
    expect(commitDataFromResponse(response("Plain subject")).prNum).toBeNull();
  });

  test("the trailer wins over a suffix naming a different PR", () => {
    const message = [
      "A title borrowed from somewhere else (#111)",
      "",
      "Pull Request resolved: https://github.com/pytorch/pytorch/pull/222",
    ].join("\n");
    expect(commitDataFromResponse(response(message)).prNum).toBe(222);
  });

  test("only the subject line carries a suffix, never the body", () => {
    // A body mentioning another PR at the end of a line is not this commit's.
    const message = ["Plain subject", "", "See also (#111)"].join("\n");
    expect(commitDataFromResponse(response(message)).prNum).toBeNull();
  });

  test("a CRLF subject still matches, since the anchor follows the trim", () => {
    expect(
      commitDataFromResponse(response("Some change (#196818)\r\n\r\nBody"))
        .prNum
    ).toBe(196818);
  });

  test("the title is the subject line and the time is the committer date", () => {
    const commit = commitDataFromResponse(response(SQUASH_MESSAGE));
    expect(commit.commitTitle).toBe(SQUASH_MESSAGE.split("\n")[0]);
    expect(commit.time).toBe("2026-09-20T16:31:20Z");
  });
});
