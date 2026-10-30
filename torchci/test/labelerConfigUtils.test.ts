import {
  draftConstraintAllowsLabel,
  getDraftGatedLabelsToRemove,
  getLabelsFromLabelerConfig,
  getLabelsNeededByFiles,
  loadLabelerConfig,
  normalizeLabelerRule,
} from "lib/bot/labelerConfigUtils";
import nock from "nock";
import * as utils from "./utils";

nock.disableNetConnect();

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

  describe("getDraftGatedLabelsToRemove", () => {
    const config = {
      "ciflow/inductor": {
        globs: ["torch/_dynamo/**"],
        draft: false,
      },
      "draft-only": {
        globs: ["torch/**"],
        draft: true,
      },
      "module: dynamo": ["torch/_dynamo/**"],
    };

    test("removes draft:false label when PR is draft", () => {
      expect(
        getDraftGatedLabelsToRemove(config, ["torch/_dynamo/a.py"], true)
      ).toEqual(["ciflow/inductor"]);
    });

    test("removes draft:true label when PR is not draft", () => {
      expect(
        getDraftGatedLabelsToRemove(config, ["torch/a.py"], false)
      ).toEqual(["draft-only"]);
    });

    test("skips legacy array rules", () => {
      expect(
        getDraftGatedLabelsToRemove(config, ["torch/_dynamo/a.py"], true)
      ).not.toContain("module: dynamo");
    });

    test("returns empty when globs do not match", () => {
      expect(getDraftGatedLabelsToRemove(config, ["docs/a.md"], true)).toEqual(
        []
      );
    });
  });
  describe("getLabelsNeededByFiles", () => {
    const config = {
      "module: dynamo": ["torch/_dynamo/**"],
      "ciflow/inductor": { globs: ["torch/_dynamo/**"], draft: false },
      broken: { globs: "bad" },
    };

    test("matches globs and respects the draft constraint", () => {
      expect(
        getLabelsNeededByFiles(config, ["torch/_dynamo/a.py"], false)
      ).toEqual(["module: dynamo", "ciflow/inductor"]);
      expect(
        getLabelsNeededByFiles(config, ["torch/_dynamo/a.py"], true)
      ).toEqual(["module: dynamo"]);
      expect(getLabelsNeededByFiles(config, ["docs/a.md"], false)).toEqual([]);
    });

    test("logs skipped rules through the callback", () => {
      const log = jest.fn();
      getLabelsNeededByFiles(config, ["torch/_dynamo/a.py"], false, log);
      expect(log).toHaveBeenCalledWith(
        { label: "broken", rawRule: { globs: "bad" } },
        "getLabelsFromLabelerConfig: unknown rule shape, skipping"
      );
    });
  });

  describe("loadLabelerConfig", () => {
    const octokit = utils.testOctokit();

    function mockFile(path: string, content: string) {
      return nock("https://api.github.com")
        .get(`/repos/pytorch/pytorch/contents/${encodeURIComponent(path)}`)
        .reply(200, {
          type: "file",
          encoding: "base64",
          path,
          content: Buffer.from(content).toString("base64"),
        });
    }

    afterEach(() => {
      nock.cleanAll();
    });

    test("reads the labeler config named in pytorch-probot.yml", async () => {
      const scope = mockFile(
        ".github/pytorch-probot.yml",
        "mergebot: True\nlabeler_config: labeler.yml\n"
      );
      mockFile(
        ".github/labeler.yml",
        '"ciflow/inductor":\n- torch/_dynamo/**\n'
      );
      expect(await loadLabelerConfig(octokit, "pytorch", "pytorch")).toEqual({
        "ciflow/inductor": ["torch/_dynamo/**"],
      });
      scope.done();
    });

    test("is null without a labeler_config key", async () => {
      const scope = mockFile(".github/pytorch-probot.yml", "mergebot: True\n");
      expect(await loadLabelerConfig(octokit, "pytorch", "pytorch")).toBeNull();
      scope.done();
    });
  });
});
