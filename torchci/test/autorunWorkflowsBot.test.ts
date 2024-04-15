import nock from "nock";
import { Probot } from "probot";
import * as utils from "./utils";
import { handleScope, requireDeepCopy } from "./common";
import myProbotApp from "../lib/bot/autorunWorkflowsBot";
import * as botUtils from "lib/bot/utils";

nock.disableNetConnect();

const nonWorkflowFiles = ["somedir/foo", "someotherdir/bar"];

const mixedWorkflowNonWorkflowFiles = [
  "somedir/foo",
  "someotherdir/bar",
  ".github/workflows/foobar.yml",
];

function mockHasApprovedWorkflowRun(repoFullName: string) {
  nock("https://api.github.com")
    .get((uri) => uri.startsWith(`/repos/${repoFullName}/actions/runs`))
    .reply(200, {
      workflow_runs: [
        {
          event: "pull_request",
          conclusion: "success",
        },
      ],
    });
}

function ghWorkflowApprovalPath(owner: string, repo: string, run_id: number) {
  return `/repos/${owner}/${repo}/actions/runs/${run_id}`;
}

describe("autorun-safe-workflows-bot", () => {
  let probot: Probot;
  function emptyMockConfig(repoFullName: string) {
    utils.mockConfig("pytorch-probot.yml", "", repoFullName);
  }

  beforeEach(() => {
    jest.restoreAllMocks();
    probot = utils.testProbot();
    probot.load(myProbotApp);
    const mock = jest.spyOn(botUtils, "isPyTorchPyTorch").mockReturnValue(true);
    emptyMockConfig("zhouzhuojie/gha-ci-playground");
  });

  afterEach(() => {
    jest.restoreAllMocks();
    nock.cleanAll();
  });

  test("approve workflow run when is first time user", async () => {
    // PR should only change files in non-workflow related directories
    jest
      .spyOn(botUtils, "getFilesChangedByPr")
      .mockReturnValue(Promise.resolve(nonWorkflowFiles));
    jest
      .spyOn(botUtils, "isFirstTimeContributor")
      .mockReturnValue(Promise.resolve(true));

    const mockRunApproval = jest
      .spyOn(botUtils, "approveWorkflowRun")
      .mockReturnValue(Promise.resolve(true));

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];

    await probot.receive({ name: "pull_request", payload: payload, id: "1" });

    // Ensure mockRunApproval was called
    expect(mockRunApproval).toBeCalledTimes(1);
  });

  test("no workflow run approval requested when is not a first time user", async () => {
    // PR should only change files in non-workflow related directories
    jest
      .spyOn(botUtils, "getFilesChangedByPr")
      .mockReturnValue(Promise.resolve(nonWorkflowFiles));
    jest
      .spyOn(botUtils, "isFirstTimeContributor")
      .mockReturnValue(Promise.resolve(false));

    const mockRunApproval = jest
      .spyOn(botUtils, "approveWorkflowRun")
      .mockReturnValue(Promise.resolve(true));

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];

    await probot.receive({ name: "pull_request", payload: payload, id: "1" });

    // Ensure mockRunApproval was not called
    expect(mockRunApproval).toBeCalledTimes(0);
  });

  test("no workflow run approval requested when is workflow files are modified", async () => {
    // PR should only change files in non-workflow related directories
    jest
      .spyOn(botUtils, "getFilesChangedByPr")
      .mockReturnValue(Promise.resolve(mixedWorkflowNonWorkflowFiles));
    jest
      .spyOn(botUtils, "isFirstTimeContributor")
      .mockReturnValue(Promise.resolve(true));

    const mockRunApproval = jest
      .spyOn(botUtils, "approveWorkflowRun")
      .mockReturnValue(Promise.resolve(true));

    const payload = requireDeepCopy("./fixtures/pull_request.opened")[
      "payload"
    ];

    await probot.receive({ name: "pull_request", payload: payload, id: "1" });

    // Ensure mockRunApproval was not called
    expect(mockRunApproval).toBeCalledTimes(0);
  });
});
