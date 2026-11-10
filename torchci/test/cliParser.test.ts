import { getParser } from "../lib/bot/cliParser";

describe("CLI Parser", () => {
  test("advertises only the supported command surface", () => {
    const usage = getParser().format_usage();
    expect(usage.match(/\{([^}]+)\}/)![1].split(",")).toEqual([
      "merge",
      "revert",
      "rebase",
      "label",
      "drci",
      "review",
      "triage",
      "lint",
      "fix-lint",
      "apply-lint",
      "cherry-pick",
    ]);
  });

  test("unknown commands are rejected", () => {
    expect(() => getParser().parse_args(["not-a-bot-command"])).toThrow();
  });
  describe("cherry-pick command", () => {
    it("should accept --onto parameter", () => {
      const parser = getParser();
      const args = parser.parse_args([
        "cherry-pick",
        "--onto",
        "release/2.1",
        "-c",
        "regression",
      ]);

      expect(args.command).toBe("cherry-pick");
      expect(args.onto).toBe("release/2.1");
      expect(args.classification).toBe("regression");
    });

    it("should accept --into as an alias for --onto", () => {
      const parser = getParser();
      const args = parser.parse_args([
        "cherry-pick",
        "--into",
        "release/2.1",
        "-c",
        "regression",
      ]);

      expect(args.command).toBe("cherry-pick");
      expect(args.onto).toBe("release/2.1"); // Value should be stored in args.onto regardless of flag used
      expect(args.classification).toBe("regression");
    });
  });

  describe("review command", () => {
    it("takes no arguments", () => {
      const parser = getParser();
      expect(parser.parse_args(["review"]).command).toBe("review");
      expect(() => parser.parse_args(["review", "now"])).toThrow();
    });
  });
});
