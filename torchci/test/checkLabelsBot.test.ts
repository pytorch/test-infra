import {
  formLabelErrComment,
  hasRequiredLabels,
  isLabelErrComment,
  LABEL_COMMENT_START,
} from "lib/bot/checkLabelsUtils";
import * as botUtils from "lib/bot/utils";
import nock from "nock";
import { Probot } from "probot";
import checkLabelsBot from "../lib/bot/checkLabelsBot";
import { handleScope, requireDeepCopy } from "./common";
import * as utils from "./utils";

nock.disableNetConnect();

describe("check-labels-bot", () => {
  let probot: Probot;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(checkLabelsBot);

    // Mock isPyTorchPyTorch to return true for test repos
    const mock = jest.spyOn(botUtils, "isPyTorchPyTorch");
    mock.mockReturnValue(true);

    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    nock.cleanAll();
  });

  describe("hasRequiredLabels", () => {
    test("returns false when no labels", () => {
      expect(hasRequiredLabels([])).toBe(false);
    });

    test("returns false when unrelated labels", () => {
      expect(hasRequiredLabels(["bug", "enhancement"])).toBe(false);
    });

    test("returns true when has topic: not user facing", () => {
      expect(hasRequiredLabels(["topic: not user facing"])).toBe(true);
    });

    test("returns true when has release notes: label", () => {
      expect(hasRequiredLabels(["release notes: nn"])).toBe(true);
    });

    test("returns true when has release notes: cuda label", () => {
      expect(hasRequiredLabels(["release notes: cuda"])).toBe(true);
    });

    test("returns true when has both labels", () => {
      expect(
        hasRequiredLabels(["topic: not user facing", "release notes: nn"])
      ).toBe(true);
    });

    test("handles whitespace in labels", () => {
      expect(hasRequiredLabels(["  topic: not user facing  "])).toBe(true);
      expect(hasRequiredLabels(["  release notes: nn  "])).toBe(true);
    });
  });

  describe("isLabelErrComment", () => {
    test("returns true for valid bot comment", () => {
      const body = formLabelErrComment();
      expect(isLabelErrComment(body, "github-actions")).toBe(true);
      expect(isLabelErrComment(body, "pytorchmergebot")).toBe(true);
      expect(isLabelErrComment(body, "pytorch-bot")).toBe(true);
    });

    test("returns false for non-bot author", () => {
      const body = formLabelErrComment();
      expect(isLabelErrComment(body, "random-user")).toBe(false);
    });

    test("returns false for comment without marker", () => {
      expect(isLabelErrComment("Some random comment", "github-actions")).toBe(
        false
      );
    });
  });

  describe("pull_request.opened", () => {
    test("adds error comment when PR opened without required labels", async () => {
      const event = requireDeepCopy("./fixtures/pull_request.opened");
      const payload = event.payload;
      payload.pull_request.labels = [];

      // Mock: no existing comments
      const scope = nock("https://api.github.com")
        .get("/repos/zhouzhuojie/gha-ci-playground/issues/31/comments")
        .reply(200, [])
        .post(
          "/repos/zhouzhuojie/gha-ci-playground/issues/31/comments",
          (body: { body: string }) => {
            expect(body.body).toContain(LABEL_COMMENT_START);
            expect(body.body).toContain("release notes:");
            return true;
          }
        )
        .reply(200);

      await probot.receive({ name: "pull_request", payload, id: "2" });

      handleScope(scope);
    });

    test("does not add comment when PR has topic: not user facing label", async () => {
      const event = requireDeepCopy("./fixtures/pull_request.opened");
      const payload = event.payload;
      payload.pull_request.labels = [{ name: "topic: not user facing" }];

      // No API calls expected for listing or creating comments

      await probot.receive({ name: "pull_request", payload, id: "2" });

      // If no scope.done() is called, the test passes if no unexpected calls were made
    });

    test("does not add comment when PR has release notes: label", async () => {
      const event = requireDeepCopy("./fixtures/pull_request.opened");
      const payload = event.payload;
      payload.pull_request.labels = [{ name: "release notes: nn" }];

      await probot.receive({ name: "pull_request", payload, id: "2" });
    });

    test("does not add duplicate comment when already exists", async () => {
      const event = requireDeepCopy("./fixtures/pull_request.opened");
      const payload = event.payload;
      payload.pull_request.labels = [];

      // Mock: existing comment from bot
      const scope = nock("https://api.github.com")
        .get("/repos/zhouzhuojie/gha-ci-playground/issues/31/comments")
        .reply(200, [
          {
            id: 123,
            body: formLabelErrComment(),
            user: { login: "github-actions" },
          },
        ]);
      // No createComment call expected

      await probot.receive({ name: "pull_request", payload, id: "2" });

      handleScope(scope);
    });
  });

  describe("pull_request.labeled", () => {
    test("deletes error comment when topic: not user facing is added", async () => {
      const payload = requireDeepCopy("./fixtures/pull_request.labeled");
      payload.label = { name: "topic: not user facing" };
      payload.pull_request.labels = [{ name: "topic: not user facing" }];

      // Mock: existing comment
      const scope = nock("https://api.github.com")
        .get("/repos/seemethere/test-repo/issues/20/comments")
        .reply(200, [
          {
            id: 456,
            body: formLabelErrComment(),
            user: { login: "github-actions" },
          },
        ])
        .delete("/repos/seemethere/test-repo/issues/comments/456")
        .reply(200);

      await probot.receive({ name: "pull_request", payload, id: "2" });

      handleScope(scope);
    });

    test("deletes error comment when release notes: label is added", async () => {
      const payload = requireDeepCopy("./fixtures/pull_request.labeled");
      payload.label = { name: "release notes: cuda" };
      payload.pull_request.labels = [{ name: "release notes: cuda" }];

      // Mock: existing comment
      const scope = nock("https://api.github.com")
        .get("/repos/seemethere/test-repo/issues/20/comments")
        .reply(200, [
          {
            id: 789,
            body: formLabelErrComment(),
            user: { login: "pytorchmergebot" },
          },
        ])
        .delete("/repos/seemethere/test-repo/issues/comments/789")
        .reply(200);

      await probot.receive({ name: "pull_request", payload, id: "2" });

      handleScope(scope);
    });

    test("does nothing when non-required label is added", async () => {
      const payload = requireDeepCopy("./fixtures/pull_request.labeled");
      payload.label = { name: "bug" };
      payload.pull_request.labels = [{ name: "bug" }];

      // No delete expected - PR still doesn't have required labels

      await probot.receive({ name: "pull_request", payload, id: "2" });
    });

    test("handles case when no comment exists to delete", async () => {
      const payload = requireDeepCopy("./fixtures/pull_request.labeled");
      payload.label = { name: "topic: not user facing" };
      payload.pull_request.labels = [{ name: "topic: not user facing" }];

      // Mock: no existing comments
      const scope = nock("https://api.github.com")
        .get("/repos/seemethere/test-repo/issues/20/comments")
        .reply(200, []);

      await probot.receive({ name: "pull_request", payload, id: "2" });

      handleScope(scope);
    });
  });

  describe("pull_request.unlabeled", () => {
    test("adds error comment when required label is removed", async () => {
      const payload = requireDeepCopy("./fixtures/pull_request.labeled");
      payload.action = "unlabeled";
      payload.label = { name: "topic: not user facing" };
      payload.pull_request.labels = []; // Label removed, now empty

      // Mock: no existing comment, then add one
      const scope = nock("https://api.github.com")
        .get("/repos/seemethere/test-repo/issues/20/comments")
        .reply(200, [])
        .post(
          "/repos/seemethere/test-repo/issues/20/comments",
          (body: { body: string }) => {
            expect(body.body).toContain(LABEL_COMMENT_START);
            return true;
          }
        )
        .reply(200);

      await probot.receive({ name: "pull_request", payload, id: "2" });

      handleScope(scope);
    });

    test("does not add comment when PR still has another required label", async () => {
      const payload = requireDeepCopy("./fixtures/pull_request.labeled");
      payload.action = "unlabeled";
      payload.label = { name: "topic: not user facing" };
      payload.pull_request.labels = [{ name: "release notes: cuda" }]; // Still valid

      await probot.receive({ name: "pull_request", payload, id: "2" });
    });

    test("does not add duplicate comment when unlabeled", async () => {
      const payload = requireDeepCopy("./fixtures/pull_request.labeled");
      payload.action = "unlabeled";
      payload.label = { name: "topic: not user facing" };
      payload.pull_request.labels = [];

      // Mock: comment already exists
      const scope = nock("https://api.github.com")
        .get("/repos/seemethere/test-repo/issues/20/comments")
        .reply(200, [
          {
            id: 999,
            body: formLabelErrComment(),
            user: { login: "pytorch-bot" },
          },
        ]);
      // No create call expected

      await probot.receive({ name: "pull_request", payload, id: "2" });

      handleScope(scope);
    });
  });

  describe("non-pytorch/pytorch repos", () => {
    test("does not run on other repos", async () => {
      // Reset mock to return false
      jest.restoreAllMocks();
      const mock = jest.spyOn(botUtils, "isPyTorchPyTorch");
      mock.mockReturnValue(false);

      const event = requireDeepCopy("./fixtures/pull_request.opened");
      const payload = event.payload;
      payload.pull_request.labels = [];

      // No API calls expected

      await probot.receive({ name: "pull_request", payload, id: "2" });
    });
  });
});
