import { isDrCIEnabled } from "lib/bot/utils";
import {
  GREENLIGHT_PRIMARY_REPO,
  GREENLIGHT_REPOS,
  greenlightRepoKey,
  isGreenlightPrimaryRepo,
  isGreenlightRepo,
} from "lib/greenlight/greenlightConfig";

describe("greenlightConfig", () => {
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
    // The asymmetry this pins: greenlight suppresses its own comment on PyTorch/PyTorch, so
    // this side must render for it too rather than falling through to no status at all.
    expect(isGreenlightRepo("pytorch", "pytorch")).toBe(true);
    expect(isGreenlightRepo("PyTorch", "PyTorch")).toBe(true);
    expect(isGreenlightRepo("PYTORCH", "pytorch")).toBe(true);
  });

  it("rejects repos that are not greenlight repos", () => {
    expect(isGreenlightRepo("pytorch", "vision")).toBe(false);
    expect(isGreenlightRepo("some", "other")).toBe(false);
  });

  it("lists only repos Dr.CI serves", () => {
    // greenlight posts no status comment of its own on these repos, so a repo Dr.CI
    // does not comment on would show greenlight's state nowhere.
    for (const repo of GREENLIGHT_REPOS) {
      const [owner, name] = repo.split("/");
      expect([repo, isDrCIEnabled(owner, name)]).toEqual([repo, true]);
    }
  });

  it("renders the primary repo", () => {
    expect(GREENLIGHT_REPOS).toContain(GREENLIGHT_PRIMARY_REPO);
  });

  it("matches the primary repo regardless of case, and no other repo", () => {
    expect(isGreenlightPrimaryRepo("pytorch", "pytorch")).toBe(true);
    expect(isGreenlightPrimaryRepo("PyTorch", "PyTorch")).toBe(true);
    expect(isGreenlightPrimaryRepo("pytorch", "executorch")).toBe(false);
    expect(isGreenlightPrimaryRepo("pytorch", "pytorch-canary")).toBe(false);
  });
});
