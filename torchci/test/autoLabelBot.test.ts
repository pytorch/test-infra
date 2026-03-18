import {
  formLabelErrComment,
  LABEL_COMMENT_START,
} from "lib/bot/checkLabelsUtils";
import * as botUtils from "lib/bot/utils";
import nock from "nock";
import { Probot } from "probot";
import myProbotApp from "../lib/bot/autoLabelBot";
import { handleScope, requireDeepCopy } from "./common";
import * as utils from "./utils";
import { mockAddLabels } from "./utils";

nock.disableNetConnect();

describe("auto-label-bot", () => {
  let probot: Probot;
  function emptyMockConfig(repoFullName: string) {
    utils.mockConfig("pytorch-probot.yml", "", repoFullName);
  }

  // Helper to mock the check-labels comment creation for tests where
  // auto-labeling doesn't add required labels (release notes: or topic: not user facing)
  function mockCheckLabelsComment(
    repoFullName: string,
    prNumber: number
  ): nock.Scope {
    return nock("https://api.github.com")
      .get(`/repos/${repoFullName}/issues/${prNumber}/comments`)
      .reply(200, [])
      .post(`/repos/${repoFullName}/issues/${prNumber}/comments`)
      .reply(200);
  }

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(myProbotApp);
    const mock = jest.spyOn(botUtils, "isPyTorchPyTorch");
    mock.mockReturnValue(true);
    const mockbotSupportedOrg = jest.spyOn(
      botUtils,
      "isPyTorchbotSupportedOrg"
    );
    mockbotSupportedOrg.mockReturnValue(true);
    // zhouzhuojie/gha-ci-playground is the repo used in almost all the tests
    utils.mockHasApprovedWorkflowRun("zhouzhuojie/gha-ci-playground");
    emptyMockConfig("zhouzhuojie/gha-ci-playground");
  });

  afterEach(() => {
    jest.restoreAllMocks();
    nock.cleanAll();
  });

  test("add triage review when issue is labeled high priority", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/issues.labeled");
    payload["label"] = { name: "high priority" };
    payload["issue"]["labels"] = [{ name: "high priority" }];
    emptyMockConfig(payload.repository.full_name);

    const scope = nock("https://api.github.com")
      .post(
        "/repos/ezyang/testing-ideal-computing-machine/issues/5/labels",
        (body) => {
          expect(body).toMatchObject({ labels: ["triage review"] });
          return true;
        }
      )
      .reply(200);

    await probot.receive({ name: "issues", payload, id: "2" });

    scope.done();
  });

  test("add rocm label when issue title contains ROCm", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/issues.opened");
    payload["issue"]["title"] = "Issue regarding ROCm";
    payload["issue"]["labels"] = [];

    const scope = nock("https://api.github.com")
      .post(
        "/repos/ezyang/testing-ideal-computing-machine/issues/5/labels",
        (body) => {
          expect(body).toMatchObject({
            labels: ["module: rocm"],
          });
          return true;
        }
      )
      .reply(200);

    await probot.receive({ name: "issues", payload: payload, id: "2" });

    scope.done();
  });

  test("add rocm label when PR title contains ROCm", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["title"] = "Issue regarding ROCm";
    payload["pull_request"]["labels"] = [];

    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200)
      .post("/repos/zhouzhuojie/gha-ci-playground/issues/31/labels", (body) => {
        expect(body).toMatchObject({
          labels: ["ciflow/rocm-mi300", "module: rocm"],
        });
        return true;
      })
      .reply(200);
    // Check-labels will post a comment since rocm labels are not required labels
    const checkLabelsScope = mockCheckLabelsComment(
      "zhouzhuojie/gha-ci-playground",
      31
    );

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    scope.done();
    handleScope(checkLabelsScope);
  });

  test("add ci-no-td label when PR title contains Reland", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["title"] = "Failed test [Reland]";
    payload["pull_request"]["labels"] = [];

    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200)
      .post("/repos/zhouzhuojie/gha-ci-playground/issues/31/labels", (body) => {
        expect(body).toMatchObject({ labels: ["ci-no-td"] });
        return true;
      })
      .reply(200);
    const checkLabelsScope = mockCheckLabelsComment(
      "zhouzhuojie/gha-ci-playground",
      31
    );
    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    scope.done();
    handleScope(checkLabelsScope);
  });

  test("add ci-no-td label when PR title contains Revert", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["title"] = "Failed test [Revert]";
    payload["pull_request"]["labels"] = [];

    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200)
      .post("/repos/zhouzhuojie/gha-ci-playground/issues/31/labels", (body) => {
        expect(body).toMatchObject({ labels: ["ci-no-td"] });
        return true;
      })
      .reply(200);
    const checkLabelsScope = mockCheckLabelsComment(
      "zhouzhuojie/gha-ci-playground",
      31
    );
    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    handleScope(scope);
    handleScope(checkLabelsScope);
  });

  test("add ci-no-td label when PR title contains mixed cases reLanD", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["title"] = "[reLanD] detect failure";
    payload["pull_request"]["labels"] = [];

    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200)
      .post("/repos/zhouzhuojie/gha-ci-playground/issues/31/labels", (body) => {
        expect(body).toMatchObject({ labels: ["ci-no-td"] });
        return true;
      })
      .reply(200);
    const checkLabelsScope = mockCheckLabelsComment(
      "zhouzhuojie/gha-ci-playground",
      31
    );
    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    scope.done();
    handleScope(checkLabelsScope);
  });

  test("no reland label added when issue title contains reland", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/issues.opened");
    payload["issue"]["title"] = "Issue Reland Does not work";
    payload["issue"]["labels"] = [{ name: "test" }];

    const scope = nock("https://api.github.com")
      .post(
        "/repos/ezyang/testing-ideal-computing-machine/issues/5/labels",
        (body) => {
          expect(body).toMatchObject({
            labels: ["ROCm"],
          });
          return true;
        }
      )
      .reply(200);

    await probot.receive({ name: "issues", payload: payload, id: "2" });

    // the api never been called.
    expect(scope.isDone()).toBe(false);
  });

  test("add skipped label when issue title contains DISABLED test", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/issues.opened");
    payload["issue"]["title"] = "DISABLED  test_blah (__main__.TestClass)";
    payload["issue"]["labels"] = [];

    const scope = nock("https://api.github.com")
      .post(
        "/repos/ezyang/testing-ideal-computing-machine/issues/5/labels",
        (body) => {
          expect(body).toMatchObject({ labels: ["skipped"] });
          return true;
        }
      )
      .reply(200);

    await probot.receive({ name: "issues", payload: payload, id: "2" });

    scope.done();
  });

  test("no skipped label added when PR title contains DISABLED test", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["title"] =
      "DISABLED test_blah (__main__.TestClass)";
    payload["pull_request"]["labels"] = [];

    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200)
      .post("/repos/zhouzhuojie/gha-ci-playground/issues/31/labels", (body) => {
        expect(body).toMatchObject({ labels: ["skipped"] });
        return true;
      })
      .reply(200);
    const checkLabelsScope = mockCheckLabelsComment(
      "zhouzhuojie/gha-ci-playground",
      31
    );

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    // the api never been called.
    expect(scope.isDone()).toBe(false);
    handleScope(checkLabelsScope);
  });

  test("non pytorch/pytorch repo do NOT add any release notes category labels", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["title"] = "Change to CI files";
    payload["pull_request"]["labels"] = [];
    const prFiles = requireDeepCopy("./fixtures/pull_files");

    const mock = jest.spyOn(botUtils, "isPyTorchPyTorch");
    mock.mockReturnValue(false);

    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200, prFiles, {
        Link: "<https://api.github.com/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100&page=1>; rel='last'",
        "X-GitHub-Media-Type": "github.v3; format=json",
      });

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    scope.done();
  });

  test("irrelevant files changed do NOT add any category labels", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["title"] = "Change to nonexistingfile.py";
    payload["pull_request"]["labels"] = [];
    const prFiles = requireDeepCopy("./fixtures/pull_files");
    prFiles["items"] = [{ filename: "nonexistingfile.py" }];

    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200, prFiles, {
        Link: "<https://api.github.com/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100&page=1>; rel='last'",
        "X-GitHub-Media-Type": "github.v3; format=json",
      });
    const checkLabelsScope = mockCheckLabelsComment(
      "zhouzhuojie/gha-ci-playground",
      31
    );

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    scope.done();
    handleScope(checkLabelsScope);
  });

  test("CI files changed triggers release notes: releng", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["title"] = "Change to CI files";
    payload["pull_request"]["labels"] = [];
    const prFiles = requireDeepCopy("./fixtures/pull_files");

    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200, prFiles, {
        Link: "<https://api.github.com/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100&page=1>; rel='last'",
        "X-GitHub-Media-Type": "github.v3; format=json",
      })
      .post("/repos/zhouzhuojie/gha-ci-playground/issues/31/labels", (body) => {
        expect(body).toMatchObject({ labels: ["release notes: releng"] });
        return true;
      })
      .reply(200);

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    scope.done();
  });

  test("Already categorized does not get overwritten", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["title"] = "Change to CI files";
    payload["pull_request"]["labels"] = [{ name: "release notes: releng" }];
    const prFiles = requireDeepCopy("./fixtures/pull_files");

    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200, prFiles, {
        Link: "<https://api.github.com/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100&page=1>; rel='last'",
        "X-GitHub-Media-Type": "github.v3; format=json",
      });

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    scope.done();
  });

  test("Already categorized does not get overwritten but still gets topiced", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["title"] = "Change to CI files";
    payload["pull_request"]["labels"] = [
      { name: "release notes: releng" },
      { name: "module: bc-breaking" },
    ];
    const prFiles = requireDeepCopy("./fixtures/pull_files");

    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200, prFiles, {
        Link: "<https://api.github.com/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100&page=1>; rel='last'",
        "X-GitHub-Media-Type": "github.v3; format=json",
      })
      .post("/repos/zhouzhuojie/gha-ci-playground/issues/31/labels", (body) => {
        expect(body).toMatchObject({ labels: ["topic: bc breaking"] });
        return true;
      })
      .reply(200);

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    scope.done();
  });

  test("Add topic: not user facing for codemods", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["title"] = "[CODEMOD] Change to CI files";
    payload["pull_request"]["labels"] = [];
    const prFiles = requireDeepCopy("./fixtures/pull_files");

    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200, prFiles, {
        Link: "<https://api.github.com/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100&page=1>; rel='last'",
        "X-GitHub-Media-Type": "github.v3; format=json",
      })
      .post("/repos/zhouzhuojie/gha-ci-playground/issues/31/labels", (body) => {
        expect(body).toMatchObject({ labels: ["topic: not user facing"] });
        return true;
      })
      .reply(200);

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    scope.done();
  });

  test("Already topic: not user facing does not get categorized", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["title"] = "[CODEMOD] Change to CI files";
    payload["pull_request"]["labels"] = [{ name: "topic: not user facing" }];
    const prFiles = requireDeepCopy("./fixtures/pull_files");

    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200, prFiles, {
        Link: "<https://api.github.com/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100&page=1>; rel='last'",
        "X-GitHub-Media-Type": "github.v3; format=json",
      });

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    scope.done();
  });

  test("caffe2 files trigger caffe2 label", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["title"] = "modify all caffe2 files";
    payload["pull_request"]["labels"] = [];
    const prFiles = requireDeepCopy("./fixtures/pull_files");
    prFiles["items"] = [
      { filename: "caffe2/a.py" },
      { filename: "something/caffe2.py" },
    ];

    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200, prFiles, {
        Link: "<https://api.github.com/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100&page=1>; rel='last'",
        "X-GitHub-Media-Type": "github.v3; format=json",
      })
      .post("/repos/zhouzhuojie/gha-ci-playground/issues/31/labels", (body) => {
        expect(body).toMatchObject({ labels: ["caffe2"] });
        return true;
      })
      .reply(200);
    const checkLabelsScope = mockCheckLabelsComment(
      "zhouzhuojie/gha-ci-playground",
      31
    );

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    scope.done();
    handleScope(checkLabelsScope);
  });

  test("caffe2 files trigger caffe2 label independently from topics", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["title"] = "modify all caffe2 files";
    payload["pull_request"]["labels"] = [{ name: "module: deprecation" }];
    const prFiles = requireDeepCopy("./fixtures/pull_files");
    prFiles["items"] = [
      { filename: "caffe2/a.py" },
      { filename: "something/caffe2.py" },
    ];

    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200, prFiles, {
        Link: "<https://api.github.com/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100&page=1>; rel='last'",
        "X-GitHub-Media-Type": "github.v3; format=json",
      })
      .post("/repos/zhouzhuojie/gha-ci-playground/issues/31/labels", (body) => {
        expect(body).toMatchObject({
          labels: ["caffe2", "topic: deprecation"],
        });
        return true;
      })
      .reply(200);
    const checkLabelsScope = mockCheckLabelsComment(
      "zhouzhuojie/gha-ci-playground",
      31
    );

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    scope.done();
    handleScope(checkLabelsScope);
  });

  test("first category found is picked", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["title"] =
      "modify distributed files as well as CI files";
    const prFiles = requireDeepCopy("./fixtures/pull_files");
    prFiles["items"].unshift({ filename: "torch/distributed/ddp/test.py" });

    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200, prFiles, {
        Link: "<https://api.github.com/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100&page=1>; rel='last'",
        "X-GitHub-Media-Type": "github.v3; format=json",
      })
      .post("/repos/zhouzhuojie/gha-ci-playground/issues/31/labels", (body) => {
        expect(body).toMatchObject({
          labels: ["release notes: distributed (ddp)"],
        });
        return true;
      })
      .reply(200);

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    scope.done();
  });

  test("files changed categories trump cuda categorization", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["title"] = "linalg cuda improvements";
    const prFiles = requireDeepCopy("./fixtures/pull_files");
    prFiles["items"] = [
      { filename: "torch/linalg/a.cu" },
      { filename: "torch/linalg/a.cuh" },
      { filename: "torch/_torch_docs.py" },
    ];

    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200, prFiles, {
        Link: "<https://api.github.com/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100&page=1>; rel='last'",
        "X-GitHub-Media-Type": "github.v3; format=json",
      })
      .post("/repos/zhouzhuojie/gha-ci-playground/issues/31/labels", (body) => {
        expect(body).toMatchObject({
          labels: ["release notes: linalg_frontend"],
        });
        return true;
      })
      .reply(200);

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    scope.done();
  });

  test("cuda categorization catches misc cu/h files", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["title"] = "linalg cuda improvements";
    const prFiles = requireDeepCopy("./fixtures/pull_files");
    prFiles["items"] = [
      { filename: "torch/onething/a.cu" },
      { filename: "torch/anotherthing/a.cuh" },
    ];

    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200, prFiles, {
        Link: "<https://api.github.com/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100&page=1>; rel='last'",
        "X-GitHub-Media-Type": "github.v3; format=json",
      })
      .post("/repos/zhouzhuojie/gha-ci-playground/issues/31/labels", (body) => {
        expect(body).toMatchObject({ labels: ["release notes: cuda"] });
        return true;
      })
      .reply(200);

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    scope.done();
  });

  test("[PyTorch Edge] Mobile info is weighed after files changed info", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["title"] =
      "[PyTorch Edge] linalg improvements for iOS";
    const prFiles = requireDeepCopy("./fixtures/pull_files");
    prFiles["items"] = [
      { filename: "torch/linalg/a.cu" },
      { filename: "torch/linalg/a.cuh" },
    ];

    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200, prFiles, {
        Link: "<https://api.github.com/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100&page=1>; rel='last'",
        "X-GitHub-Media-Type": "github.v3; format=json",
      })
      .post("/repos/zhouzhuojie/gha-ci-playground/issues/31/labels", (body) => {
        expect(body).toMatchObject({
          labels: ["release notes: linalg_frontend"],
        });
        return true;
      })
      .reply(200);

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    scope.done();
  });

  test("Title with (case-sensitive) [PyTorch Edge] means mobile", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["title"] = "[PyTorch Edge] improvements to iOS";
    const prFiles = requireDeepCopy("./fixtures/pull_files");
    prFiles["items"] = [
      { filename: "ios/sometest.py" },
      { filename: "ios/someothertest.py" },
    ];

    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200, prFiles, {
        Link: "<https://api.github.com/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100&page=1>; rel='last'",
        "X-GitHub-Media-Type": "github.v3; format=json",
      })
      .post("/repos/zhouzhuojie/gha-ci-playground/issues/31/labels", (body) => {
        expect(body).toMatchObject({ labels: ["release notes: mobile"] });
        return true;
      })
      .reply(200);

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    scope.done();
  });

  test("single common_methods_invocations.py change = python_frontend", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["title"] =
      "Very awesome change to common methods invocations";
    const prFiles = requireDeepCopy("./fixtures/pull_files");
    prFiles["items"] = [
      { filename: "torch/testing/_internal/common_methods_invocations.py" },
    ];

    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200, prFiles, {
        Link: "<https://api.github.com/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100&page=1>; rel='last'",
        "X-GitHub-Media-Type": "github.v3; format=json",
      })
      .post("/repos/zhouzhuojie/gha-ci-playground/issues/31/labels", (body) => {
        expect(body).toMatchObject({
          labels: ["release notes: python_frontend"],
        });
        return true;
      })
      .reply(200);

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    scope.done();
  });

  test("single torch/_torch_docs.py change = python_frontend", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["title"] = "Improving torch docs";
    const prFiles = requireDeepCopy("./fixtures/pull_files");
    prFiles["items"] = [{ filename: "torch/_torch_docs.py" }];

    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200, prFiles, {
        Link: "<https://api.github.com/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100&page=1>; rel='last'",
        "X-GitHub-Media-Type": "github.v3; format=json",
      })
      .post("/repos/zhouzhuojie/gha-ci-playground/issues/31/labels", (body) => {
        expect(body).toMatchObject({
          labels: ["release notes: python_frontend"],
        });
        return true;
      })
      .reply(200);

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    scope.done();
  });

  test("topic: not user facing is added for unuser facing files", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["title"] = "Not user facing!";
    const prFiles = requireDeepCopy("./fixtures/pull_files");
    prFiles["items"] = [
      { filename: ".github/scripts/update_commit_hashes.py" },
      { filename: "CODEOWNERS" },
      { filename: "something/Makefile" },
      { filename: "test/test_jit.py" },
      { filename: "third_party/eigen" },
      { filename: "blah.ini" },
      { filename: "blah.txt" },
      { filename: "blah.md" },
      { filename: "blah.MD" },
    ];

    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200, prFiles, {
        Link: "<https://api.github.com/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100&page=1>; rel='last'",
        "X-GitHub-Media-Type": "github.v3; format=json",
      })
      .post("/repos/zhouzhuojie/gha-ci-playground/issues/31/labels", (body) => {
        expect(body).toMatchObject({ labels: ["topic: not user facing"] });
        return true;
      })
      .reply(200);

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    scope.done();
  });

  test("topic: not user facing is NOT added if there's an interesting file", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["title"] = "Linalg plus other irrelevant stuff";
    const prFiles = requireDeepCopy("./fixtures/pull_files");
    prFiles["items"] = [
      { filename: "torch/linalg/a.cu" },
      { filename: "blah.ini" },
      { filename: "blah.txt" },
      { filename: "blah.md" },
      { filename: "blah.MD" },
    ];

    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200, prFiles, {
        Link: "<https://api.github.com/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100&page=1>; rel='last'",
        "X-GitHub-Media-Type": "github.v3; format=json",
      })
      .post("/repos/zhouzhuojie/gha-ci-playground/issues/31/labels", (body) => {
        expect(body).toMatchObject({
          labels: ["release notes: linalg_frontend"],
        });
        return true;
      })
      .reply(200);

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    scope.done();
  });

  test("topic: not user facing is NOT added if matches both include and exclude list", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["title"] =
      "Derivatives.yaml change plus other irrelevant stuff";
    const prFiles = requireDeepCopy("./fixtures/pull_files");
    prFiles["items"] = [
      { filename: "tools/autograd/derivatives.yaml" },
      { filename: "blah.ini" },
      { filename: "blah.txt" },
      { filename: "blah.md" },
      { filename: "blah.MD" },
    ];

    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200, prFiles, {
        Link: "<https://api.github.com/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100&page=1>; rel='last'",
        "X-GitHub-Media-Type": "github.v3; format=json",
      });
    const checkLabelsScope = mockCheckLabelsComment(
      "zhouzhuojie/gha-ci-playground",
      31
    );
    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    scope.done();
    handleScope(checkLabelsScope);
  });

  test("PR author to label, author NOT in list", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["user"]["login"] = "some-random-user";
    const scope = nock("https://api.github.com")
      // mock no changed files
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200, [], {
        Link: "<https://api.github.com/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100&page=1>; rel='last'",
        "X-GitHub-Media-Type": "github.v3; format=json",
      });
    const checkLabelsScope = mockCheckLabelsComment(
      "zhouzhuojie/gha-ci-playground",
      31
    );
    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    handleScope(scope);
    handleScope(checkLabelsScope);
  });

  test("PR author to label, author in list", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["user"]["login"] = "pytorchupdatebot";
    const scope = [
      nock("https://api.github.com")
        // mock no changed files
        .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
        .reply(200, [], {
          Link: "<https://api.github.com/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100&page=1>; rel='last'",
          "X-GitHub-Media-Type": "github.v3; format=json",
        }),
      mockAddLabels(["ci-no-td"], "zhouzhuojie/gha-ci-playground", 31),
      mockCheckLabelsComment("zhouzhuojie/gha-ci-playground", 31),
    ];
    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    handleScope(scope);
  });
});

describe("auto-label-bot: labeler.yml config", () => {
  let probot: Probot;

  function mockChangedFiles(
    changedFiles: string[],
    prNumber: number,
    repoFullName: string
  ) {
    const scope = nock("https://api.github.com")
      .get(`/repos/${repoFullName}/pulls/${prNumber}/files?per_page=100`)
      .reply(200, changedFiles, {
        Link: `<https://api.github.com/repos/${repoFullName}/pulls/${prNumber}/files?per_page=100&page=1>; rel='last'`,
        "X-GitHub-Media-Type": "github.v3; format=json",
      });
    return scope;
  }

  function mockCheckLabelsComment(
    repoFullName: string,
    prNumber: number
  ): nock.Scope {
    return nock("https://api.github.com")
      .get(`/repos/${repoFullName}/issues/${prNumber}/comments`)
      .reply(200, [])
      .post(`/repos/${repoFullName}/issues/${prNumber}/comments`)
      .reply(200);
  }

  function defaultMockConfig(repoFullName: string) {
    const config = `
"module: dynamo":
- torch/_dynamo/**
- torch/csrc/dynamo/**

"ciflow/inductor":
- torch/_decomp/**
- torch/_dynamo/**
`;
    utils.mockConfig(
      "pytorch-probot.yml",
      "labeler_config: labeler.yml",
      repoFullName
    );
    utils.mockConfig("labeler.yml", config, repoFullName);
  }

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(myProbotApp);
    const mock = jest.spyOn(botUtils, "isPyTorchPyTorch");
    mock.mockReturnValue(true);
    const mockbotSupportedOrg = jest.spyOn(
      botUtils,
      "isPyTorchbotSupportedOrg"
    );
    mockbotSupportedOrg.mockReturnValue(true);
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    nock.cleanAll();
  });

  test("getLabelsFromLabelerConfig no matches", async () => {
    const event = requireDeepCopy("./fixtures/pull_request.opened");
    const prFiles = requireDeepCopy("./fixtures/pull_files");
    prFiles["items"] = [{ filename: "torch/blah.py" }];
    const repoFullName = "zhouzhuojie/gha-ci-playground";
    const prNumber = 31;
    const scope = mockChangedFiles(prFiles, prNumber, repoFullName);
    defaultMockConfig(repoFullName);
    utils.mockHasApprovedWorkflowRun(repoFullName);
    const checkLabelsScope = mockCheckLabelsComment(repoFullName, prNumber);
    await probot.receive(event);
    scope.done();
    handleScope(checkLabelsScope);
  });

  test("getLabelsFromLabelerConfig one match", async () => {
    const event = requireDeepCopy("./fixtures/pull_request.opened");
    const prFiles = requireDeepCopy("./fixtures/pull_files");
    prFiles["items"] = [{ filename: "torch/csrc/dynamo/blah.py" }];
    const repoFullName = "zhouzhuojie/gha-ci-playground";
    const prNumber = 31;
    const scope = mockChangedFiles(prFiles, prNumber, repoFullName);
    defaultMockConfig(repoFullName);
    utils.mockHasApprovedWorkflowRun(repoFullName);
    const scope2 = utils.mockAddLabels(
      ["module: dynamo"],
      repoFullName,
      prNumber
    );
    const checkLabelsScope = mockCheckLabelsComment(repoFullName, prNumber);
    await probot.receive(event);
    scope.done();
    scope2.done();
    handleScope(checkLabelsScope);
  });

  test("getLabelsFromLabelerConfig multiple match for single file", async () => {
    const event = requireDeepCopy("./fixtures/pull_request.opened");
    const prFiles = requireDeepCopy("./fixtures/pull_files");
    prFiles["items"] = [{ filename: "torch/_dynamo/blah.py" }];
    const repoFullName = "zhouzhuojie/gha-ci-playground";
    const prNumber = 31;
    const scope = mockChangedFiles(prFiles, prNumber, repoFullName);
    defaultMockConfig(repoFullName);
    utils.mockHasApprovedWorkflowRun(repoFullName);
    const scope2 = utils.mockAddLabels(
      ["module: dynamo", "ciflow/inductor"],
      repoFullName,
      prNumber
    );
    const checkLabelsScope = mockCheckLabelsComment(repoFullName, prNumber);
    await probot.receive(event);
    scope.done();
    scope2.done();
    handleScope(checkLabelsScope);
  });

  test("getLabelsFromLabelerConfig multiple match with multiple file", async () => {
    const event = requireDeepCopy("./fixtures/pull_request.opened");
    const prFiles = requireDeepCopy("./fixtures/pull_files");
    prFiles["items"] = [
      { filename: "torch/csrc/dynamo/blah.py" },
      { filename: "torch/_decomp/blah.py" },
    ];
    const repoFullName = "zhouzhuojie/gha-ci-playground";
    const prNumber = 31;
    const scope = mockChangedFiles(prFiles, prNumber, repoFullName);
    defaultMockConfig(repoFullName);
    utils.mockHasApprovedWorkflowRun(repoFullName);
    const scope2 = utils.mockAddLabels(
      ["module: dynamo", "ciflow/inductor"],
      repoFullName,
      prNumber
    );
    const checkLabelsScope = mockCheckLabelsComment(repoFullName, prNumber);
    await probot.receive(event);
    scope.done();
    scope2.done();
    handleScope(checkLabelsScope);
  });

  test("getLabelsFromLabelerConfig multiple match but no workflow permissions", async () => {
    // Matches both module: dynamo and ciflow/inductor, but removes ciflow due to lacking perms
    const event = requireDeepCopy("./fixtures/pull_request.opened");
    const prFiles = requireDeepCopy("./fixtures/pull_files");
    prFiles["items"] = [{ filename: "torch/_dynamo/blah.py" }];
    const repoFullName = "zhouzhuojie/gha-ci-playground";
    const prNumber = 31;
    const scope = mockChangedFiles(prFiles, prNumber, repoFullName);
    defaultMockConfig(repoFullName);
    nock("https://api.github.com")
      .get((uri) => uri.startsWith(`/repos/${repoFullName}/actions/runs`))
      .reply(200, {
        workflow_runs: [
          {
            event: "pull_request",
            conclusion: "action_required",
          },
        ],
      })
      .get(`/repos/${repoFullName}/collaborators/zzj-bot/permission`)
      .reply(200, {
        permission: "read",
      });
    const scope2 = utils.mockAddLabels(
      ["module: dynamo"],
      repoFullName,
      prNumber
    );
    const checkLabelsScope = mockCheckLabelsComment(repoFullName, prNumber);
    await probot.receive(event);
    scope.done();
    scope2.done();
    handleScope(checkLabelsScope);
  });
});

describe("auto-label-bot: label-to-label.yml config", () => {
  let probot: Probot;

  function defaultMockConfig(repoFullName: string) {
    const config = `
- any:
  - "module: custom operators"
  - "module: aotdispatch"
  then:
  - "module: pt2-dispatcher"
- any:
  - "module: dynamo"
  - "module: pt2-dispatcher"
  - "module: inductor"
  - "module: custom operators"
  then:
  - "oncall: pt2"
- all:
  - "allif1"
  - "allif2"
  then:
  - "allthen1"
- all:
  - "module: custom operators"
  - "allif3"
  then:
  - "allthen2"
- any:
  - "testciflow1"
  then:
  - "ciflow/2"
`;
    utils.mockConfig(
      "pytorch-probot.yml",
      "label_to_label_config: label-to-label.yml",
      repoFullName
    );
    utils.mockConfig("label-to-label.yml", config, repoFullName);
  }

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(myProbotApp);
    const mock = jest.spyOn(botUtils, "isPyTorchPyTorch");
    mock.mockReturnValue(true);
    const mockbotSupportedOrg = jest.spyOn(
      botUtils,
      "isPyTorchbotSupportedOrg"
    );
    mockbotSupportedOrg.mockReturnValue(true);
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    nock.cleanAll();
  });

  test("getLabelsFromLabelerConfig issue any", async () => {
    const event = requireDeepCopy("./fixtures/issues.labeled");
    event.label.name = "module: dynamo";
    defaultMockConfig(event.repository.full_name);
    const scope = utils.mockAddLabels(
      ["oncall: pt2"],
      event.repository.full_name,
      event.issue.number
    );
    await probot.receive({ name: "issues", id: "2", payload: event });
    handleScope(scope);
  });

  test("getLabelsFromLabelerConfig issue all", async () => {
    const event = requireDeepCopy("./fixtures/issues.labeled");
    event.label.name = "allif1";
    event.issue.labels = [{ name: "allif2" }, { name: "allif1" }];
    defaultMockConfig(event.repository.full_name);
    const scope = utils.mockAddLabels(
      ["allthen1"],
      event.repository.full_name,
      event.issue.number
    );
    await probot.receive({ name: "issues", id: "2", payload: event });
    handleScope(scope);
  });

  test("getLabelsFromLabelerConfig multiple any rules", async () => {
    const event = requireDeepCopy("./fixtures/issues.labeled");
    event.label.name = "module: custom operators";
    event.issue.labels = [
      { name: "allif2" },
      { name: "allif1" },
      { name: "module: custom operators" },
    ];
    defaultMockConfig(event.repository.full_name);
    const scope = utils.mockAddLabels(
      ["module: pt2-dispatcher", "oncall: pt2"],
      event.repository.full_name,
      event.issue.number
    );
    await probot.receive({ name: "issues", id: "2", payload: event });
    handleScope(scope);
  });

  test("getLabelsFromLabelerConfig any and all", async () => {
    const event = requireDeepCopy("./fixtures/issues.labeled");
    event.label.name = "module: custom operators";
    event.issue.labels = [
      { name: "allif2" },
      { name: "allif3" },
      { name: "module: custom operators" },
    ];
    defaultMockConfig(event.repository.full_name);
    const scope = utils.mockAddLabels(
      ["module: pt2-dispatcher", "oncall: pt2", "allthen2"],
      event.repository.full_name,
      event.issue.number
    );
    await probot.receive({ name: "issues", id: "2", payload: event });
    handleScope(scope);
  });
});

describe("test TD rollout labeling", () => {
  let probot: Probot;

  function mockNoChangedFiles(prNumber: number, repoFullName: string) {
    const scope = nock("https://api.github.com")
      .get(`/repos/${repoFullName}/pulls/${prNumber}/files?per_page=100`)
      .reply(200, [], {
        Link: `<https://api.github.com/repos/${repoFullName}/pulls/${prNumber}/files?per_page=100&page=1>; rel='last'`,
        "X-GitHub-Media-Type": "github.v3; format=json",
      });
    return scope;
  }

  function mockCheckLabelsComment(
    repoFullName: string,
    prNumber: number
  ): nock.Scope {
    return nock("https://api.github.com")
      .get(`/repos/${repoFullName}/issues/${prNumber}/comments`)
      .reply(200, [])
      .post(`/repos/${repoFullName}/issues/${prNumber}/comments`)
      .reply(200);
  }

  function defaultMockConfig(repoFullName: string) {
    const issue = `
adfadsfasd
* @clee2000
*@huydo
`;
    utils.mockConfig(
      "pytorch-probot.yml",
      "TD_rollout_issue: 123",
      repoFullName
    );
    const payload = require("./fixtures/issue.json");
    payload["body"] = issue;
    nock("https://api.github.com")
      .get(`/repos/${repoFullName}/issues/123`)
      .reply(200, payload);
  }

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(myProbotApp);
    const mock = jest.spyOn(botUtils, "isPyTorchPyTorch");
    mock.mockReturnValue(true);
    const mockbotSupportedOrg = jest.spyOn(
      botUtils,
      "isPyTorchbotSupportedOrg"
    );
    mockbotSupportedOrg.mockReturnValue(true);
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    nock.cleanAll();
  });

  test("Add label if author on list", async () => {
    const event = requireDeepCopy("./fixtures/pull_request.opened");
    const repoFullName = "zhouzhuojie/gha-ci-playground";
    const prNumber = event.payload.pull_request.number;
    event.payload.pull_request.user.login = "clee2000";
    defaultMockConfig(repoFullName);
    utils.mockHasApprovedWorkflowRun(repoFullName);
    mockNoChangedFiles(prNumber, repoFullName);
    const scope = utils.mockAddLabels(
      ["ci-td-distributed"],
      repoFullName,
      prNumber
    );
    const checkLabelsScope = mockCheckLabelsComment(repoFullName, prNumber);

    await probot.receive(event);
    handleScope(scope);
    handleScope(checkLabelsScope);
  });

  test("Do not add label if author on list", async () => {
    const event = requireDeepCopy("./fixtures/pull_request.opened");
    const repoFullName = "zhouzhuojie/gha-ci-playground";
    const prNumber = event.payload.pull_request.number;
    event.payload.pull_request.user.login = "random";
    defaultMockConfig(repoFullName);
    utils.mockHasApprovedWorkflowRun(repoFullName);
    mockNoChangedFiles(prNumber, repoFullName);
    const checkLabelsScope = mockCheckLabelsComment(repoFullName, prNumber);
    await probot.receive(event);
    handleScope(checkLabelsScope);
  });

  test("Don't do anything if no config", async () => {
    const event = requireDeepCopy("./fixtures/pull_request.opened");
    const repoFullName = "zhouzhuojie/gha-ci-playground";
    const prNumber = event.payload.pull_request.number;
    event.payload.pull_request.user.login = "random";
    utils.mockConfig("pytorch-probot.yml", "", repoFullName);
    utils.mockHasApprovedWorkflowRun(repoFullName);
    mockNoChangedFiles(prNumber, repoFullName);
    const checkLabelsScope = mockCheckLabelsComment(repoFullName, prNumber);
    await probot.receive(event);
    handleScope(checkLabelsScope);
  });
});

describe("auto-label-bot: label restrictions", () => {
  let probot: Probot;

  function emptyMockConfig(repoFullName: string) {
    utils.mockConfig("pytorch-probot.yml", "", repoFullName);
  }

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(myProbotApp);
    const mock = jest.spyOn(botUtils, "isPyTorchPyTorch");
    mock.mockReturnValue(true);
    const mockbotSupportedOrg = jest.spyOn(
      botUtils,
      "isPyTorchbotSupportedOrg"
    );
    mockbotSupportedOrg.mockReturnValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    nock.cleanAll();
  });

  test("remove release notes label from issue", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/issues.labeled");
    payload["label"] = { name: "release notes: nn" };
    payload["issue"]["labels"] = [{ name: "release notes: nn" }];
    emptyMockConfig(payload.repository.full_name);

    const scope = nock("https://api.github.com")
      .delete(
        "/repos/ezyang/testing-ideal-computing-machine/issues/5/labels/release%20notes%3A%20nn"
      )
      .reply(200)
      .post(
        "/repos/ezyang/testing-ideal-computing-machine/issues/5/comments",
        (body) => {
          expect(body.body).toContain("release notes: nn");
          expect(body.body).toContain("only applicable to pull requests");
          return true;
        }
      )
      .reply(200);

    await probot.receive({ name: "issues", payload, id: "2" });

    handleScope(scope);
  });

  test("remove ciflow label from issue", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/issues.labeled");
    payload["label"] = { name: "ciflow/rocm" };
    payload["issue"]["labels"] = [{ name: "ciflow/rocm" }];
    emptyMockConfig(payload.repository.full_name);

    const scope = nock("https://api.github.com")
      .delete(
        "/repos/ezyang/testing-ideal-computing-machine/issues/5/labels/ciflow%2Frocm"
      )
      .reply(200)
      .post(
        "/repos/ezyang/testing-ideal-computing-machine/issues/5/comments",
        (body) => {
          expect(body.body).toContain("ciflow/rocm");
          expect(body.body).toContain("only applicable to pull requests");
          return true;
        }
      )
      .reply(200);

    await probot.receive({ name: "issues", payload, id: "2" });

    handleScope(scope);
  });

  test("remove oncall label from pull request", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.labeled");
    payload["label"] = { name: "oncall: distributed" };
    payload["pull_request"]["labels"] = [{ name: "oncall: distributed" }];
    emptyMockConfig(payload.repository.full_name);

    const scope = nock("https://api.github.com")
      .delete(
        "/repos/seemethere/test-repo/issues/20/labels/oncall%3A%20distributed"
      )
      .reply(200)
      .post("/repos/seemethere/test-repo/issues/20/comments", (body) => {
        expect(body.body).toContain("oncall: distributed");
        expect(body.body).toContain("only applicable to issues");
        return true;
      })
      .reply(200);

    await probot.receive({ name: "pull_request", payload, id: "2" });

    handleScope(scope);
  });
});

describe("auto-label-bot: check-labels integration", () => {
  let probot: Probot;

  function emptyMockConfig(repoFullName: string) {
    utils.mockConfig("pytorch-probot.yml", "", repoFullName);
  }

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(myProbotApp);
    const mock = jest.spyOn(botUtils, "isPyTorchPyTorch");
    mock.mockReturnValue(true);
    const mockbotSupportedOrg = jest.spyOn(
      botUtils,
      "isPyTorchbotSupportedOrg"
    );
    mockbotSupportedOrg.mockReturnValue(true);
    utils.mockHasApprovedWorkflowRun("zhouzhuojie/gha-ci-playground");
    emptyMockConfig("zhouzhuojie/gha-ci-playground");
  });

  afterEach(() => {
    jest.restoreAllMocks();
    nock.cleanAll();
  });

  test("adds error comment when PR opened without required labels after auto-labeling", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["title"] = "Some random PR";
    payload["pull_request"]["labels"] = [];

    // Mock: no changed files (so no auto-labels will be added)
    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200, [], {
        Link: "<https://api.github.com/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100&page=1>; rel='last'",
        "X-GitHub-Media-Type": "github.v3; format=json",
      })
      // Mock: no existing error comment
      .get("/repos/zhouzhuojie/gha-ci-playground/issues/31/comments")
      .reply(200, [])
      // Expect: error comment is posted
      .post(
        "/repos/zhouzhuojie/gha-ci-playground/issues/31/comments",
        (body: { body: string }) => {
          expect(body.body).toContain(LABEL_COMMENT_START);
          expect(body.body).toContain("release notes:");
          return true;
        }
      )
      .reply(200);

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    handleScope(scope);
  });

  test("does not add error comment when auto-labeling adds required label", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["title"] = "Change to CI files";
    payload["pull_request"]["labels"] = [];
    const prFiles = requireDeepCopy("./fixtures/pull_files");

    // Auto-labeling will add "release notes: releng" based on .github files
    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200, prFiles, {
        Link: "<https://api.github.com/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100&page=1>; rel='last'",
        "X-GitHub-Media-Type": "github.v3; format=json",
      })
      .post("/repos/zhouzhuojie/gha-ci-playground/issues/31/labels", (body) => {
        expect(body).toMatchObject({ labels: ["release notes: releng"] });
        return true;
      })
      .reply(200);
    // No error comment expected since auto-labeling adds the required label

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    handleScope(scope);
  });

  test("does not add error comment when PR already has required label", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["title"] = "Some random PR";
    payload["pull_request"]["labels"] = [{ name: "topic: not user facing" }];

    // Mock: no changed files
    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200, [], {
        Link: "<https://api.github.com/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100&page=1>; rel='last'",
        "X-GitHub-Media-Type": "github.v3; format=json",
      });
    // No error comment expected since PR already has the required label

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    handleScope(scope);
  });

  test("does not add error comment when auto-labeling adds topic: not user facing", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["title"] = "Not user facing!";
    const prFiles = requireDeepCopy("./fixtures/pull_files");
    prFiles["items"] = [
      { filename: ".github/scripts/update_commit_hashes.py" },
      { filename: "test/test_jit.py" },
    ];

    // Auto-labeling will add "topic: not user facing" based on file patterns
    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200, prFiles, {
        Link: "<https://api.github.com/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100&page=1>; rel='last'",
        "X-GitHub-Media-Type": "github.v3; format=json",
      })
      .post("/repos/zhouzhuojie/gha-ci-playground/issues/31/labels", (body) => {
        expect(body).toMatchObject({ labels: ["topic: not user facing"] });
        return true;
      })
      .reply(200);
    // No error comment expected since auto-labeling adds the required label

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    handleScope(scope);
  });

  test("does not add duplicate error comment when one already exists", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["title"] = "Some random PR";
    payload["pull_request"]["labels"] = [];

    // Mock: no changed files (so no auto-labels will be added)
    // Mock: existing error comment from bot
    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200, [], {
        Link: "<https://api.github.com/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100&page=1>; rel='last'",
        "X-GitHub-Media-Type": "github.v3; format=json",
      })
      .get("/repos/zhouzhuojie/gha-ci-playground/issues/31/comments")
      .reply(200, [
        {
          id: 123,
          body: formLabelErrComment(),
          user: { login: "github-actions" },
        },
      ]);
    // No createComment call expected since one already exists

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    handleScope(scope);
  });

  test("does not run check-labels for non-pytorch/pytorch repos", async () => {
    // Reset mock to return false for isPyTorchPyTorch
    jest.restoreAllMocks();
    const mock = jest.spyOn(botUtils, "isPyTorchPyTorch");
    mock.mockReturnValue(false);
    const mockbotSupportedOrg = jest.spyOn(
      botUtils,
      "isPyTorchbotSupportedOrg"
    );
    mockbotSupportedOrg.mockReturnValue(true);

    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["title"] = "Some random PR";
    payload["pull_request"]["labels"] = [];

    const prFiles = requireDeepCopy("./fixtures/pull_files");
    utils.mockHasApprovedWorkflowRun("zhouzhuojie/gha-ci-playground");
    emptyMockConfig("zhouzhuojie/gha-ci-playground");

    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200, prFiles, {
        Link: "<https://api.github.com/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100&page=1>; rel='last'",
        "X-GitHub-Media-Type": "github.v3; format=json",
      });
    // No error comment or labels expected for non-pytorch/pytorch repos

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    handleScope(scope);
  });

  test("does not run check-labels for edited PRs (only opened)", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["action"] = "edited"; // Changed from "opened" to "edited"
    payload["pull_request"]["title"] = "Some random PR";
    payload["pull_request"]["labels"] = [];

    // Mock: no changed files
    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100")
      .reply(200, [], {
        Link: "<https://api.github.com/repos/zhouzhuojie/gha-ci-playground/pulls/31/files?per_page=100&page=1>; rel='last'",
        "X-GitHub-Media-Type": "github.v3; format=json",
      });
    // No error comment expected for edited PRs

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    handleScope(scope);
  });
});
