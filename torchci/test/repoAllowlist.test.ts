import { isRepoEnabled, parseRepoAllowlist } from "lib/bot/repoAllowlist";

describe("parseRepoAllowlist", () => {
  test("an unset value disables the handler", () => {
    expect(parseRepoAllowlist(undefined).size).toBe(0);
    expect(parseRepoAllowlist("").size).toBe(0);
  });

  test("entries are trimmed and lowercased", () => {
    expect(parseRepoAllowlist(" Pytorch/PyTorch , meta-pytorch/* ")).toEqual(
      new Set(["pytorch/pytorch", "meta-pytorch/*"])
    );
  });

  test("empty entries from a trailing comma are dropped", () => {
    expect(parseRepoAllowlist("pytorch/pytorch,,").size).toBe(1);
  });
});

describe("isRepoEnabled", () => {
  test("matches an exact repo", () => {
    const allowlist = parseRepoAllowlist("pytorch/pytorch");
    expect(isRepoEnabled(allowlist, "pytorch", "pytorch")).toBe(true);
    expect(isRepoEnabled(allowlist, "pytorch", "executorch")).toBe(false);
  });

  test("matches a whole org via a wildcard", () => {
    const allowlist = parseRepoAllowlist("meta-pytorch/*");
    expect(isRepoEnabled(allowlist, "meta-pytorch", "torchcomms")).toBe(true);
    expect(isRepoEnabled(allowlist, "meta-pytorch", "monarch")).toBe(true);
    expect(isRepoEnabled(allowlist, "pytorch", "pytorch")).toBe(false);
  });

  test("an org wildcard does not leak into a similarly named org", () => {
    const allowlist = parseRepoAllowlist("pytorch/*");
    expect(isRepoEnabled(allowlist, "meta-pytorch", "torchcomms")).toBe(false);
  });

  test("comparison is case insensitive", () => {
    const allowlist = parseRepoAllowlist("PyTorch/PyTorch");
    expect(isRepoEnabled(allowlist, "pytorch", "pytorch")).toBe(true);
  });
});
