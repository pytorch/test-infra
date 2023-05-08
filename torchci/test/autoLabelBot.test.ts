import nock from "nock";
import { Probot } from "probot";
import * as utils from "./utils";
import { requireDeepCopy } from "./common";
import myProbotApp from "../lib/bot/autoLabelBot";
import * as botUtils from "lib/bot/utils";

nock.disableNetConnect();

describe("auto-label-bot", () => {
  let probot: Probot;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(myProbotApp);
    const mock = jest.spyOn(botUtils, "isPyTorchPyTorch");
    mock.mockReturnValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("add triage review when issue is labeled high priority", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/issues.labeled");
    payload["label"] = { name: "high priority" };
    payload["issue"]["labels"] = [{ name: "high priority" }];

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
          expect(body).toMatchObject({ labels: ["module: rocm"] });
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
        expect(body).toMatchObject({ labels: ["module: rocm"] });
        return true;
      })
      .reply(200);

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    scope.done();
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

  test("add skipped label when PR title contains DISABLED test", async () => {
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

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    scope.done();
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

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    scope.done();
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
        expect(body).toMatchObject({ labels: ["topic: bc_breaking"] });
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

  test("custom repo labels get add when on a matching repo and file", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];
    payload["pull_request"]["title"] = "modify a pytorch/fake-test-repo file";
    payload["pull_request"]["labels"] = [];
    payload["repository"]["owner"]["login"] = "pytorch";
    payload["repository"]["name"] = "fake-test-repo";
    const prFiles = requireDeepCopy("./fixtures/pull_files");
    prFiles["items"] = [
      { filename: "somefolder/a.py" },
      { filename: "otherfolder/b.py" },
    ];

    const scope = nock("https://api.github.com")
      .get("/repos/pytorch/fake-test-repo/pulls/31/files?per_page=100")
      .reply(200, prFiles, {
        Link: "<https://api.github.com/repos/pytorch/fake-test-repo/pulls/31/files?per_page=100&page=1>; rel='last'",
        "X-GitHub-Media-Type": "github.v3; format=json",
      })
      .post("/repos/pytorch/fake-test-repo/issues/31/labels", (body) => {
        expect(body).toMatchObject({ labels: ["cool-label"] });
        return true;
      })
      .reply(200);

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

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    scope.done();
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

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    scope.done();
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
    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    scope.done();
  });

  test("Review adds ciflow/trunk label", async () => {
    // TODO: Revert me
    return;
    const event = requireDeepCopy("./fixtures/pull_request_review.json");
    event.payload.review.state = "approved";
    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.pull_request.number;

    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const scope = nock("https://api.github.com")
      .get(
        `/repos/${owner}/${repo}/collaborators/${event.payload.review.user.login}/permission`
      )
      .reply(200, { permission: "write" })
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/labels`, (body) => {
        expect(JSON.stringify(body)).toContain(`"labels":["ciflow/trunk"]`);
        return true;
      })
      .reply(200, {});
    await probot.receive(event);

    scope.done();
  });
});
