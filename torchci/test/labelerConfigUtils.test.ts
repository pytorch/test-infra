import {
  draftConstraintAllowsLabel,
  getLabelsFromLabelerConfig,
  normalizeLabelerRule,
} from "lib/bot/labelerConfigUtils";

describe("labelerConfigUtils", () => {
  describe("normalizeLabelerRule", () => {
    test("accepts legacy glob array", () => {
      expect(normalizeLabelerRule(["a/**", "b/**"])).toEqual(["a/**", "b/**"]);
    });

    test("accepts object with globs and draft", () => {
      expect(normalizeLabelerRule({ globs: ["x/**"], draft: false })).toEqual({
        globs: ["x/**"],
        draft: false,
      });
    });

    test("rejects non-boolean draft", () => {
      expect(
        normalizeLabelerRule({ globs: ["x/**"], draft: "false" })
      ).toBeNull();
    });

    test("rejects invalid shapes", () => {
      expect(normalizeLabelerRule(null)).toBeNull();
      expect(normalizeLabelerRule({ globs: "bad" })).toBeNull();
    });
  });

  describe("draftConstraintAllowsLabel", () => {
    test("legacy array has no draft constraint", () => {
      expect(draftConstraintAllowsLabel(["**"], true)).toBe(true);
      expect(draftConstraintAllowsLabel(["**"], false)).toBe(true);
    });

    test("draft false applies only when not draft", () => {
      const rule = { globs: ["**"], draft: false as const };
      expect(draftConstraintAllowsLabel(rule, true)).toBe(false);
      expect(draftConstraintAllowsLabel(rule, false)).toBe(true);
    });

    test("draft true applies only on drafts", () => {
      const rule = { globs: ["**"], draft: true as const };
      expect(draftConstraintAllowsLabel(rule, true)).toBe(true);
      expect(draftConstraintAllowsLabel(rule, false)).toBe(false);
    });
  });

  describe("getLabelsFromLabelerConfig", () => {
    test("skips label when draft:false and PR is draft", async () => {
      const tracker = {
        loadLabelsConfig: async () => ({
          "ciflow/x": {
            globs: ["torch/**"],
            draft: false,
          },
        }),
      };
      const context = { log: jest.fn() } as any;
      const labels = await getLabelsFromLabelerConfig(
        context,
        tracker as any,
        ["torch/a.py"],
        true
      );
      expect(labels).toEqual([]);
    });

    test("adds label when draft:false and PR is not draft", async () => {
      const tracker = {
        loadLabelsConfig: async () => ({
          "ciflow/x": {
            globs: ["torch/**"],
            draft: false,
          },
        }),
      };
      const context = { log: jest.fn() } as any;
      const labels = await getLabelsFromLabelerConfig(
        context,
        tracker as any,
        ["torch/a.py"],
        false
      );
      expect(labels).toEqual(["ciflow/x"]);
    });

    test("skips rule with invalid draft type and logs distinct message", async () => {
      const tracker = {
        loadLabelsConfig: async () => ({
          "ciflow/x": {
            globs: ["torch/**"],
            draft: "false",
          },
        }),
      };
      const context = { log: jest.fn() } as any;
      const labels = await getLabelsFromLabelerConfig(
        context,
        tracker as any,
        ["torch/a.py"],
        false
      );
      expect(labels).toEqual([]);
      expect(context.log).toHaveBeenCalledWith(
        {
          label: "ciflow/x",
          rawRule: { globs: ["torch/**"], draft: "false" },
          draft: "false",
        },
        "getLabelsFromLabelerConfig: invalid draft type (expected boolean), skipping"
      );
    });

    test("defaults isDraft to false when omitted (3-arg call)", async () => {
      const tracker = {
        loadLabelsConfig: async () => ({
          "ciflow/x": {
            globs: ["torch/**"],
            draft: false,
          },
        }),
      };
      const context = { log: jest.fn() } as any;
      const labels = await getLabelsFromLabelerConfig(context, tracker as any, [
        "torch/a.py",
      ]);
      expect(labels).toEqual(["ciflow/x"]);
    });
  });
});
