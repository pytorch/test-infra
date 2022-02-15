import nock from "nock";
import * as utils from "./utils";
import * as disableFlakyTestBot from "../pages/api/flaky-tests/disable";

nock.disableNetConnect();

const flakyTestA = {
    file: "file_a",
    suite: "suite_a",
    name: "test_a",
    num_green: 4,
    num_red: 2,
    workflow_ids: ["12345678", "13456789", "14253647"],
    workflow_names: ["win-cpu-vs-2019", "periodic-win-cuda11.3-vs-2019", "periodic-win-cuda11.3-vs-2019"],
}

describe("Disable Flaky Test Bot Integration Tests", () => {
  const octokit = utils.testOctokit();

  beforeEach(() => {
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("previously undetected flaky test should create an issue", async () => {
    const scope = nock("https://raw.githubusercontent.com")
        .get(`/pytorch/pytorch/master/test/${flakyTestA.file}.py`)
        .reply(200, Buffer.from(`# Owner(s): ["module: fft"]\nimport blah;\nrest of file`));
    const scope2 = nock("https://api.github.com")
        .post("/repos/pytorch/pytorch/issues", (body) => {
            expect(body.title).toEqual("DISABLED test_a (__main__.suite_a)");
            expect(body.labels).toEqual(["skipped", "module: flaky-tests", "module: fft", "triaged"]);
            expect(JSON.stringify(body.body)).toContain("Platforms: ");
            return true;
        })
        .reply(200, {});

    await disableFlakyTestBot.handleFlakyTest(flakyTestA, [], octokit);

    if (!nock.isDone()) {
        console.error("pending mocks: %j", scope.pendingMocks());
        console.error("pending mocks: %j", scope2.pendingMocks());
    }
  });

  test("flaky test associated with an open issue should comment", async () => {
    const scope = nock("https://api.github.com")
        .post("/repos/pytorch/pytorch/issues/1/comments", (body) => {
            const comment = JSON.stringify(body.body);
            expect(comment).toContain("Another case of flakiness has been found");
            expect(comment).toContain("Please verify");
            return true;
        })
        .reply(200, {});

    const issues = [{
        number: 1,
        title: "DISABLED test_a (__main__.suite_a)",
        html_url: "https://api.github.com/repos/pytorch/pytorch/issues/1",
        state: ("open" as "open" | "closed")
    }];

    await disableFlakyTestBot.handleFlakyTest(flakyTestA, issues, octokit);

    if (!scope.isDone()) {
        console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("flaky test associated with a closed issue should reopen issue and comment", async () => {
    const scope = nock("https://api.github.com")
        .patch("/repos/pytorch/pytorch/issues/1", (body) => {
            expect(body).toMatchObject({state: "open"});
            return true;
        })
        .reply(200, {})
        .post("/repos/pytorch/pytorch/issues/1/comments", (body) => {
            const comment = JSON.stringify(body.body);
            expect(comment).toContain("Another case of flakiness has been found");
            expect(comment).toContain("Reopening");
            return true;
        })
        .reply(200, {});

    const issues = [{
        number: 1,
        title: "DISABLED test_a (__main__.suite_a)",
        html_url: "https://api.github.com/pytorch/pytorch/issues/1",
        state: ("closed" as "open" | "closed")
    }];

    await disableFlakyTestBot.handleFlakyTest(flakyTestA, issues, octokit);

    if (!scope.isDone()) {
        console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });
});

describe("Disable Flaky Test Bot Unit Tests", () => {
    beforeEach(() => {
    });

    afterEach(() => {
      nock.cleanAll();
      jest.restoreAllMocks();
    });


    test("getTestOwnerLabels: owned test file should return proper module along with triaged", async () => {
        const scope = nock("https://raw.githubusercontent.com/")
            .get(`/pytorch/pytorch/master/test/${flakyTestA.file}.py`)
            .reply(200, Buffer.from(`# Owner(s): ["module: fft"]\nimport blah;\nrest of file`));

        const labels = await disableFlakyTestBot.getTestOwnerLabels(flakyTestA.file);
        expect(labels).toEqual(["module: fft", "triaged"]);

        if (!scope.isDone()) {
            console.error("pending mocks: %j", scope.pendingMocks());
        }
        scope.done();
    });

    test("getTestOwnerLabels: un-owned high priority test file should NOT return triaged", async () => {
        const scope = nock("https://raw.githubusercontent.com/")
            .get(`/pytorch/pytorch/master/test/${flakyTestA.file}.py`)
            .reply(200, Buffer.from(`# Owner(s): ["high priority"]\nimport blah;\nrest of file`));

        const labels = await disableFlakyTestBot.getTestOwnerLabels(flakyTestA.file);
        expect(labels).toEqual(["high priority"]);

        if (!scope.isDone()) {
            console.error("pending mocks: %j", scope.pendingMocks());
        }
        scope.done();
    });

    test("getTestOwnerLabels: un-owned test file should return module: unknown", async () => {
        const scope = nock("https://raw.githubusercontent.com/")
            .get(`/pytorch/pytorch/master/test/${flakyTestA.file}.py`)
            .reply(200, Buffer.from(`# Owner(s): ["module: unknown"]\nimport blah;\nrest of file`));

        const labels = await disableFlakyTestBot.getTestOwnerLabels(flakyTestA.file);
        expect(labels).toEqual(["module: unknown"]);

        if (!scope.isDone()) {
            console.error("pending mocks: %j", scope.pendingMocks());
        }
        scope.done();
    });

    test("getTestOwnerLabels: ill-formatted file should return module: unknown", async () => {
        const scope = nock("https://raw.githubusercontent.com/")
            .get(`/pytorch/pytorch/master/test/${flakyTestA.file}.py`)
            .reply(200, Buffer.from("line1\nline2\nline3\nstill no owners\nline4\nlastline\n"));

        const labels = await disableFlakyTestBot.getTestOwnerLabels(flakyTestA.file);
        expect(labels).toEqual(["module: unknown"]);

        if (!scope.isDone()) {
            console.error("pending mocks: %j", scope.pendingMocks());
        }
        scope.done();
    });

    test("getLatestWorkflowURL: should return URL of last workflow", async () => {
        expect(disableFlakyTestBot.getLatestWorkflowURL(flakyTestA.workflow_ids))
            .toEqual("https://github.com/pytorch/pytorch/actions/runs/14253647");
    });

    test("getIssueTitle: test suite in subclass should not have __main__", async () => {
        expect(disableFlakyTestBot.getIssueTitle("test_cool_op_cpu", "jit.async.SpecialSuite"))
            .toEqual("DISABLED test_cool_op_cpu (jit.async.SpecialSuite)");
    });

    test("getIssueTitle: test suite not in subclass should be prefixed with __main__", async () => {
        expect(disableFlakyTestBot.getIssueTitle("test_cool_op_cpu", "TestLinAlgCPU"))
            .toEqual("DISABLED test_cool_op_cpu (__main__.TestLinAlgCPU)");
    });

    test("getPlatformsAffected: should correctly triage workflows of one platform", async () => {
        const workflows = ["periodic-linux-cuda11.1-py3", "whatever-whatever-linux"]
        expect(disableFlakyTestBot.getPlatformsAffected(workflows)).toEqual(["linux"]);
    });

    test("getPlatformsAffected: should correctly triage workflows of various platforms", async () => {
        const workflows = flakyTestA.workflow_names.concat(["something-macos-build", "linux-blah-py3"]);
        expect(disableFlakyTestBot.getPlatformsAffected(workflows)).toEqual(["linux", "mac", "macos", "win"]);
    });

    test("getIssueBodyForFlakyTest: should contain Platforms line", async () => {
        expect(disableFlakyTestBot.getIssueBodyForFlakyTest(flakyTestA)).toContain("Platforms: ");
    });
  })


