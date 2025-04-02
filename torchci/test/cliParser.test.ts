import { getParser } from "../lib/bot/cliParser";

describe("CLI Parser", () => {
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
});
