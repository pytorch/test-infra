import {
  GREENLIGHT_REPOS,
  greenlightRepoKey,
  isGreenlightEnabled,
  isGreenlightRepo,
} from "lib/greenlight/greenlightConfig";

describe("greenlightConfig", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("normalizes every configured repo at construction", () => {
    // Lookup folds case, so an entry that is not already folded could never match.
    for (const repo of GREENLIGHT_REPOS) {
      expect(repo).toBe(repo.trim().toLowerCase());
    }
  });

  it.each([
    ["pytorch", "pytorch", "pytorch/pytorch"],
    ["PyTorch", "PyTorch", "pytorch/pytorch"],
    ["PYTORCH", "pytorch", "pytorch/pytorch"],
    ["  pytorch", "pytorch  ", "pytorch/pytorch"],
  ])("folds %s/%s to the canonical key", (owner, repo, expected) => {
    // normalize_repo in greenlight/src/greenlight/constants.py must fold identically; the
    // two gates disagreeing on the key leaves a PR with no status on either surface.
    expect(greenlightRepoKey(owner, repo)).toBe(expected);
  });

  it("does not repair whitespace around the separator", () => {
    // Both sides trim the whole key rather than its halves, so interior space survives and
    // the gate fails closed. Pinned because the fix for that must land on both sides at
    // once: repairing it here alone would suppress on one surface and render on neither.
    expect(greenlightRepoKey("  pytorch  ", "  pytorch  ")).toBe(
      "pytorch  /  pytorch"
    );
    expect(isGreenlightRepo("  pytorch  ", "  pytorch  ")).toBe(false);
  });

  it("matches a greenlight repo regardless of case", () => {
    expect(isGreenlightRepo("pytorch", "pytorch")).toBe(true);
    expect(isGreenlightRepo("PyTorch", "PyTorch")).toBe(true);
    expect(isGreenlightRepo("PYTORCH", "pytorch")).toBe(true);
  });

  it("rejects repos that are not greenlight repos", () => {
    expect(isGreenlightRepo("pytorch", "vision")).toBe(false);
    expect(isGreenlightRepo("some", "other")).toBe(false);
  });

  it("requires both the flag and repo membership", () => {
    process.env.DRCI_GREENLIGHT_COMMENT_ENABLED = "true";
    expect(isGreenlightEnabled("pytorch", "pytorch")).toBe(true);
    expect(isGreenlightEnabled("pytorch", "vision")).toBe(false);

    process.env.DRCI_GREENLIGHT_COMMENT_ENABLED = "false";
    expect(isGreenlightEnabled("pytorch", "pytorch")).toBe(false);

    delete process.env.DRCI_GREENLIGHT_COMMENT_ENABLED;
    expect(isGreenlightEnabled("pytorch", "pytorch")).toBe(false);
  });

  it("gates a differently-cased repo the same way the Python side does", () => {
    // The asymmetry this pins: greenlight suppresses its own comment on PyTorch/PyTorch, so
    // this side must render for it too rather than falling through to no status at all.
    process.env.DRCI_GREENLIGHT_COMMENT_ENABLED = "true";
    expect(isGreenlightEnabled("PyTorch", "PyTorch")).toBe(true);
  });

  it("treats membership as separable from the display flag", () => {
    delete process.env.DRCI_GREENLIGHT_COMMENT_ENABLED;
    expect(isGreenlightRepo("pytorch", "pytorch")).toBe(true);
    expect(isGreenlightEnabled("pytorch", "pytorch")).toBe(false);
  });
});
