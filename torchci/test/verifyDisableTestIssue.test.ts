import _ from "lodash";
import * as botUtils from "lib/bot/utils";
import nock from "nock";
import { Probot } from "probot";
import * as bot from "../lib/bot/verifyDisableTestIssueBot";
import myProbotApp, {
  disabledKey,
  pytorchBotId,
  unstableKey,
} from "../lib/bot/verifyDisableTestIssueBot";
import { handleScope, requireDeepCopy } from "./common";
import * as utils from "./utils";

nock.disableNetConnect();

describe("Verify disable issues unittests", () => {
  test("issue opened with title starts w/ DISABLED: unauthorized", async () => {
    let title = "DISABLED pull / linux-bionic-py3.8-clang9";
    const jobName = bot.parseTitle(title, disabledKey);
    let comment = bot.formJobValidationComment(
      "mock-user",
      false,
      jobName,
      disabledKey
    );

    expect(
      comment.includes("You (mock-user) don't have permission to disable")
    ).toBeTruthy();
    expect(comment.includes("ERROR")).toBeTruthy();
  });

  test("issue opened with title starts w/ UNSTABLE: to mark a job as unstable", async () => {
    const title = "UNSTABLE windows-binary-libtorch-release";

    const jobName = bot.parseTitle(title, unstableKey);
    expect(jobName).toEqual("windows-binary-libtorch-release");

    let comment = bot.formJobValidationComment(
      "mock-user",
      true,
      jobName,
      unstableKey
    );
    expect(comment.includes(`~15 minutes, \`${jobName}\``)).toBeTruthy();
    expect(comment.includes("ERROR")).toBeFalsy();
  });
});

describe("Verify disable issues integration tests", () => {
  let probot: Probot;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(myProbotApp);
    const mockManagedOrg = jest.spyOn(botUtils, "isPyTorchManagedOrg");
    mockManagedOrg.mockReturnValue(true);
  });

  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });
  function mockCloseIssue(owner: string, repo: string, number: number) {
    return nock("https://api.github.com")
      .patch(
        `/repos/${owner}/${repo}/issues/${number}`,
        (body) => body.state === "closed"
      )
      .reply(200);
  }

  function mockFetchExistingComment(
    owner: string,
    repo: string,
    number: number
  ) {
    return nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=10`)
      .reply(200, []);
  }

  function mockCommentHas(
    owner: string,
    repo: string,
    number: number,
    shouldContain: string[],
    shouldNotContain: string[]
  ) {
    return nock("https://api.github.com")
      .post(
        `/repos/${owner}/${repo}/issues/${number}/comments`,

        (body) => {
          for (const containedString of shouldContain) {
            expect(body.body).toContain(containedString);
          }
          for (const notContainedString of shouldNotContain) {
            expect(body.body).not.toContain(notContainedString);
          }
          return true;
        }
      )
      .reply(200);
  }

  function defaultE2ETestInputs({
    title,
    body,
    userLogin,
    labels,
  }: {
    title?: string;
    body?: string;
    userLogin?: string;
    labels?: string[];
  }) {
    const payload = requireDeepCopy("./fixtures/issues.opened.json");
    payload.issue.title = "DISABLED test_method_name (testClass.TestSuite)";
    payload.issue.user.id = pytorchBotId;
    payload.issue.labels = [];

    if (title !== undefined) {
      payload.issue.title = title;
    }
    if (body !== undefined) {
      payload.issue.body = body;
    }
    if (userLogin !== undefined) {
      payload.issue.user.id = 12345;
      payload.issue.user.login = userLogin;
    }
    if (labels !== undefined) {
      payload.issue.labels = labels.map((label) => ({
        name: label,
      }));
    }

    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const number = payload.issue.number;

    return {
      payload,
      owner,
      repo,
      number,
    };
  }

  describe("authorization", () => {
    test("pytorch-bot[bot] is authorized", async () => {
      const { payload, owner, repo, number } = defaultE2ETestInputs({});

      const scope = [
        mockFetchExistingComment(owner, repo, number),
        mockCommentHas(
          owner,
          repo,
          number,
          ["<!-- validation-comment-start -->", "all platforms"],
          ["don't have permission", "ERROR", "WARNING"]
        ),
      ];
      await probot.receive({ name: "issues", payload: payload, id: "2" });

      handleScope(scope);
    });

    test("random user is not authorized", async () => {
      const { payload, owner, repo, number } = defaultE2ETestInputs({
        userLogin: "randomuser",
      });

      const scope = [
        mockFetchExistingComment(owner, repo, number),
        nock("https://api.github.com")
          .get(`/repos/${owner}/${repo}/collaborators/randomuser/permission`)
          .reply(200, {
            permission: "read",
          }),
        mockCommentHas(
          owner,
          repo,
          number,
          [
            "don't have permission",
            "<!-- validation-comment-start -->",
            "ERROR",
          ],
          ["WARNING"]
        ),
        mockCloseIssue(owner, repo, number),
      ];

      await probot.receive({ name: "issues", payload: payload, id: "2" });

      handleScope(scope);
    });
  });

  describe("single disable test issues", () => {
    test("issue with missing labels adds labels", async () => {
      const { payload, owner, repo, number } = defaultE2ETestInputs({
        labels: [],
        body: "Platforms: rocm",
      });

      const scope = [
        mockFetchExistingComment(owner, repo, number),
        mockCommentHas(
          owner,
          repo,
          number,
          ["<!-- validation-comment-start -->", "these platforms: rocm."],
          ["don't have permission", "ERROR", "WARNING"]
        ),
        nock("https://api.github.com")
          .post(`/repos/${owner}/${repo}/issues/${number}/labels`, (body) =>
            _.isEqual(body.labels, ["module: rocm"])
          )
          .reply(200, []),
      ];

      await probot.receive({ name: "issues", payload: payload, id: "2" });

      handleScope(scope);
    });

    test("issue with wrong labels adds and removes labels", async () => {
      const { payload, owner, repo, number } = defaultE2ETestInputs({
        body: "Platforms: rocm",
        labels: ["module: windows", "random label"],
      });

      const scope = [
        mockFetchExistingComment(owner, repo, number),
        mockCommentHas(
          owner,
          repo,
          number,
          ["<!-- validation-comment-start -->", "these platforms: rocm."],
          ["don't have permission", "ERROR", "WARNING"]
        ),
        nock("https://api.github.com")
          .post(`/repos/${owner}/${repo}/issues/${number}/labels`, (body) =>
            _.isEqual(body.labels, ["module: rocm"])
          )
          .reply(200, [])
          .delete(
            `/repos/${owner}/${repo}/issues/${number}/labels/module%3A%20windows`
          )
          .reply(200, []),
      ];

      await probot.receive({ name: "issues", payload: payload, id: "2" });

      handleScope(scope);
    });

    test("issue with correct labels doesn't change", async () => {
      const { payload, owner, repo, number } = defaultE2ETestInputs({
        body: "Platforms: rocm",
        labels: ["module: rocm", "random label"],
      });

      const scope = [
        mockFetchExistingComment(owner, repo, number),
        mockCommentHas(
          owner,
          repo,
          number,
          ["<!-- validation-comment-start -->", "these platforms: rocm."],
          ["don't have permission", "ERROR", "WARNING"]
        ),
      ];
      await probot.receive({ name: "issues", payload: payload, id: "2" });

      handleScope(scope);
    });

    test("issue opened with title starts w/ DISABLED: disable for win", async () => {
      const { payload, owner, repo, number } = defaultE2ETestInputs({
        body: "Platforms: win",
        labels: ["module: windows", "random label"],
      });

      const scope = [
        mockFetchExistingComment(owner, repo, number),
        mockCommentHas(
          owner,
          repo,
          number,
          ["<!-- validation-comment-start -->", "these platforms: win."],
          ["don't have permission", "ERROR", "WARNING"]
        ),
      ];
      await probot.receive({ name: "issues", payload: payload, id: "2" });

      handleScope(scope);
    });

    test("issue opened with title starts w/ DISABLED: disable for win", async () => {
      const { payload, owner, repo, number } = defaultE2ETestInputs({
        body: "whatever\nPlatforms:win\nyay",
        labels: ["module: windows", "random label"],
      });

      const scope = [
        mockFetchExistingComment(owner, repo, number),
        mockCommentHas(
          owner,
          repo,
          number,
          ["<!-- validation-comment-start -->", "these platforms: win."],
          ["don't have permission", "ERROR", "WARNING"]
        ),
      ];
      await probot.receive({ name: "issues", payload: payload, id: "2" });

      handleScope(scope);
    });

    test("issue opened with title starts w/ DISABLED: disable for windows, rocm, asan", async () => {
      const { payload, owner, repo, number } = defaultE2ETestInputs({
        body: "Platforms: win, ROCm, ASAN",
        labels: ["random label"],
      });

      const scope = [
        mockFetchExistingComment(owner, repo, number),
        mockCommentHas(
          owner,
          repo,
          number,
          [
            "<!-- validation-comment-start -->",
            "~15 minutes, `test_method_name (testClass.TestSuite)` will be disabled",
            "these platforms: asan, rocm, win.",
          ],
          ["don't have permission", "ERROR", "WARNING"]
        ),
      ];
      await probot.receive({ name: "issues", payload: payload, id: "2" });

      handleScope(scope);
    });

    test("issue opened with title starts w/ DISABLED: disable for all", async () => {
      const { payload, owner, repo, number } = defaultE2ETestInputs({
        body: "whatever yay",
        labels: ["random label"],
      });

      const scope = [
        mockFetchExistingComment(owner, repo, number),
        mockCommentHas(
          owner,
          repo,
          number,
          [
            "<!-- validation-comment-start -->",
            "~15 minutes, `test_method_name (testClass.TestSuite)` will be disabled",
            "all platforms.",
          ],
          ["don't have permission", "ERROR", "WARNING"]
        ),
      ];
      await probot.receive({ name: "issues", payload: payload, id: "2" });

      handleScope(scope);
    });

    test("issue opened with title starts w/ DISABLED: disable unknown platform", async () => {
      const { payload, owner, repo, number } = defaultE2ETestInputs({
        body: "whatever\nPlatforms:invalid\nyay",
        labels: ["random label"],
      });

      const scope = [
        mockFetchExistingComment(owner, repo, number),
        mockCommentHas(
          owner,
          repo,
          number,
          [
            "<!-- validation-comment-start -->",
            "all platforms",
            "WARNING",
            "invalid inputs as platforms for which the test will be disabled: invalid.",
          ],
          ["don't have permission", "ERROR"]
        ),
      ];
      await probot.receive({ name: "issues", payload: payload, id: "2" });

      handleScope(scope);
    });

    test("issue opened with title starts w/ DISABLED: can parse nested test suites", async () => {
      const { payload, owner, repo, number } = defaultE2ETestInputs({
        body: "Platforms: win",
        labels: ["module: windows", "random label"],
        title:
          "DISABLED test_method_name   (quantization.core.test_workflow_ops.TestFakeQuantizeOps)",
      });

      const scope = [
        mockFetchExistingComment(owner, repo, number),
        mockCommentHas(
          owner,
          repo,
          number,
          [
            "<!-- validation-comment-start -->",
            "these platforms: win.",
            "test_method_name (quantization.core.test_workflow_ops.TestFakeQuantizeOps)",
          ],
          ["don't have permission", "ERROR", "WARNING"]
        ),
      ];
      await probot.receive({ name: "issues", payload: payload, id: "2" });

      handleScope(scope);
    });

    test("issue opened with title starts w/ DISABLED: cannot parse platforms", async () => {
      const { payload, owner, repo, number } = defaultE2ETestInputs({
        body: "Platforms: all of them",
        labels: ["random label"],
      });

      const scope = [
        mockFetchExistingComment(owner, repo, number),
        mockCommentHas(
          owner,
          repo,
          number,
          ["<!-- validation-comment-start -->", "all platforms", "WARNING"],
          ["don't have permission", "ERROR"]
        ),
      ];
      await probot.receive({ name: "issues", payload: payload, id: "2" });

      handleScope(scope);
    });

    test("issue opened with title starts w/ DISABLED:, not a test", async () => {
      const { payload, owner, repo, number } = defaultE2ETestInputs({
        body: "whatever\nPlatforms:\nyay",
        labels: ["module: windows", "random label"],
        title: "DISABLED test_method_name   cuz it borked  ",
      });

      const scope = [
        mockFetchExistingComment(owner, repo, number),
        mockCommentHas(
          owner,
          repo,
          number,
          ["<!-- validation-comment-start -->", "attempting to disabled a job"],
          ["don't have permission", "WARNING", "ERROR"]
        ),
      ];

      await probot.receive({ name: "issues", payload: payload, id: "2" });

      handleScope(scope);
    });
  });

  describe("multiple disable test issues", () => {
    test("normal case", async () => {
      const body = `disable the following tests:
\`\`\`
test_a (__main__.suite_a): win
test_b (__main__.suite_a): win, linux
test_c (__main__.suite_a):
\`\`\`
`;
      const { payload, owner, repo, number } = defaultE2ETestInputs({
        title: "DISABLED MULTIPLE junk random",
        body: body,
      });

      const scope = [
        mockFetchExistingComment(owner, repo, number),
        mockCommentHas(
          owner,
          repo,
          number,
          ["<!-- validation-comment-start -->"],
          ["don't have permission", "ERROR", "WARNING"]
        ),
      ];

      await probot.receive({ name: "issues", payload: payload, id: "2" });

      handleScope(scope);
    });

    test("invalid platforms", async () => {
      const body = `disable the following tests:
\`\`\`
test_a (__main__.suite_a): win, invalid
test_b (__main__.suite_a): win, linux
test_c (__main__.suite_a):
\`\`\`
`;

      const { payload, owner, repo, number } = defaultE2ETestInputs({
        title: "DISABLED MULTIPLE junk random",
        body: body,
      });

      const scope = [
        mockFetchExistingComment(owner, repo, number),
        mockCommentHas(
          owner,
          repo,
          number,
          ["<!-- validation-comment-start -->", "WARNING"],
          ["don't have permission", "ERROR"]
        ),
      ];

      await probot.receive({ name: "issues", payload: payload, id: "2" });

      handleScope(scope);
    });

    test("invalid test name", async () => {
      const body = `disable the following tests:
\`\`\`
test_a asdf (__main__.suite_a): win
test_b (__main__.suite_a): win, linux
test_c (__main__.suite_a):
\`\`\`
      `;
      const { payload, owner, repo, number } = defaultE2ETestInputs({
        title: "DISABLED MULTIPLE junk random",
        body: body,
      });

      const scope = [
        mockFetchExistingComment(owner, repo, number),
        mockCommentHas(
          owner,
          repo,
          number,
          ["<!-- validation-comment-start -->", "ERROR"],
          ["don't have permission", "WARNING"]
        ),
      ];

      await probot.receive({ name: "issues", payload: payload, id: "2" });

      handleScope(scope);
    });
  });
});
