import { TIME_0 } from "lib/bot/utils";
import * as drciUtils from "lib/drciUtils";
import {
  DOCS_URL,
  DRCI_COMMENT_START,
  formDrciComment,
  formDrciHeader,
  formDrciSevBody,
  getActiveSEVs,
  HUD_URL,
  OH_URL,
} from "lib/drciUtils";
import * as fetchPR from "lib/fetchPR";
import * as fetchRecentWorkflows from "lib/fetchRecentWorkflows";
import * as jobUtils from "lib/jobUtils";
import { removeJobNameSuffix } from "lib/jobUtils";
import { IssueData, RecentWorkflowsData } from "lib/types";
import nock from "nock";
import * as updateDrciBot from "../pages/api/drci/drci";
import { genIssueData, getDummyJob } from "./utils";

nock.disableNetConnect();

export const successfulA = getDummyJob({
  name: "linux-docs / build-docs (cpp)",
  conclusion: "success",
  completed_at: "2022-07-13 19:34:03",
  html_url: "abcdefg",
  head_sha: "abcdefg",
  pr_number: 1000,
  id: 1,
});

const pendingA = getDummyJob({
  name: "linux-docs / build-docs (cpp)",
  conclusion: "",
  completed_at: TIME_0,
  html_url: "abcdefg",
  head_sha: "abcdefg",
  id: 1,
  pr_number: 1001,
  failure_lines: ["a"],
  failure_captures: [],
  runnerName: "dummy",
});

const failedA = getDummyJob({
  name: "somethingA",
  conclusion: "failure",
  completed_at: "2022-07-13 19:34:03",
  html_url: "a",
  head_sha: "abcdefg",
  id: 1,
  pr_number: 1001,
  failure_lines: ["a"],
  failure_captures: ["mind blown", "ha ha"],
  runnerName: "dummy",
});

const failedASuccessfulRetry = getDummyJob({
  name: "somethingA",
  conclusion: "success",
  completed_at: "2022-07-14 19:34:03",
  html_url: "a",
  head_sha: "abcdefg",
  id: 2,
  pr_number: 1001,
  failure_captures: ["a"],
  runnerName: "dummy",
});

const failedAFailedRetry = getDummyJob({
  name: "somethingA",
  conclusion: "failure",
  completed_at: "2022-07-15 19:34:03",
  html_url: "a",
  head_sha: "abcdefg",
  id: 3,
  pr_number: 1001,
  failure_lines: ["a"],
  failure_captures: ["Retired but mind still blown", "ha ha ha"],
  runnerName: "dummy",
});

const failedB = getDummyJob({
  name: "something",
  conclusion: "failure",
  completed_at: "2022-07-13 19:34:03",
  html_url: "a",
  head_sha: "abcdefg",
  id: 1,
  pr_number: 1001,
  failure_lines: ["a"],
  failure_captures: ["cde"],
  runnerName: "dummy",
});

const failedC = getDummyJob({
  name: "z-docs / build-docs (cpp)",
  conclusion: "failure",
  completed_at: "2022-07-13 19:34:03",
  html_url: "a",
  head_sha: "abcdefg",
  id: 1,
  pr_number: 1001,
  failure_lines: ["a"],
  failure_captures: ["bababa"],
  runnerName: "dummy",
});

const failedD = getDummyJob({
  name: "linux-bionic-cuda12.1-py3.10-gcc9-sm86 / test (default, 1, 5, linux.g5.4xlarge.nvidia.gpu)",
  conclusion: "failure",
  completed_at: "2022-07-13 19:34:03",
  html_url: "a",
  head_sha: "abcdefg",
  id: 1,
  pr_number: 1001,
  failure_lines: ["a", "b"],
  failure_captures: ["a", "b"],
  runnerName: "dummy",
});

// Same as failedD but has a different shard ID
const failedE = getDummyJob({
  name: "linux-bionic-cuda12.1-py3.10-gcc9-sm86 / test (default, 3, 5, linux.g5.4xlarge.nvidia.gpu)",
  conclusion: "failure",
  completed_at: "2022-07-13 19:34:03",
  html_url: "a",
  head_sha: "abcdefg",
  id: 1,
  pr_number: 1001,
  failure_lines: ["a", "b"],
  failure_captures: ["a", "b"],
  runnerName: "dummy",
});

// Same as unstable A but without the unstable suffix
const failedF = getDummyJob({
  name: "win-vs2019-cpu-py3 / test (default, 2, 3, windows.4xlarge)",
  conclusion: "failure",
  completed_at: "2022-07-13 19:34:03",
  html_url: "a",
  head_sha: "abcdefg",
  id: 1,
  pr_number: 1001,
  failure_lines: ["a", "b"],
  failure_captures: ["a", "b"],
  runnerName: "dummy",
});

// Some additional mock samples for flaky rules regex match
const failedG = getDummyJob({
  name: "win-vs2019-cpu-py3 / build",
  conclusion: "failure",
  completed_at: "2022-07-13 19:34:03",
  html_url: "a",
  head_sha: "abcdefg",
  id: 1,
  pr_number: 1001,
  failure_lines: [
    "The process cannot access the file 'C:\\actions-runner\\_work\\_actions\\mock' because it is being used by another process.",
  ],
  failure_captures: [
    "The process cannot access the file 'C:\\actions-runner\\_work\\_actions\\mock' because it is being used by another process.",
  ],
  runnerName: "dummy",
});

const failedH = getDummyJob({
  name: "cuda12.1-py3.10-gcc9-sm86-periodic-dynamo-benchmarks / test (dynamo_eager_huggingface, 1, 1, linux.g5.4xlarge.nvidia.gpu)",
  conclusion: "failure",
  completed_at: "2022-07-13 19:34:03",
  html_url: "a",
  head_sha: "abcdefg",
  id: 1,
  pr_number: 1001,
  failure_lines: [
    "##[error]The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.",
  ],
  failure_captures: [
    "##[error]The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.",
  ],
  runnerName: "dummy",
});

// Match with failure line string instead of failure capture array
const failedI = getDummyJob({
  name: "macos-12-py3-arm64 / test (default, 2, 3, macos-m1-stable)",
  conclusion: "failure",
  completed_at: "2022-07-13 19:34:03",
  html_url: "a",
  head_sha: "abcdefg",
  id: 1,
  pr_number: 1001,
  failure_captures: [],
  failure_lines: [
    "RuntimeError: inductor/test_torchinductor_opinfo 2/2 failed! Received signal: SIGSEGV",
  ],
  runnerName: "dummy",
});

const unstableA = getDummyJob({
  name: "win-vs2019-cpu-py3 / test (default, 1, 3, windows.4xlarge, unstable)",
  conclusion: "failure",
  completed_at: "2022-07-13 19:34:03",
  html_url: "a",
  head_sha: "abcdefg",
  id: 1,
  pr_number: 1001,
  failure_lines: ["a", "b"],
  failure_captures: ["a", "b"],
  runnerName: "dummy",
});

// From the list of mock unstable jobs
const unstableB = getDummyJob({
  name: "trunk / test-coreml-delegate / macos-job",
  conclusion: "failure",
  completed_at: "2022-07-13 19:34:03",
  html_url: "a",
  head_sha: "abcdefg",
  id: 1,
  pr_number: 1001,
  failure_lines: ["a", "b"],
  failure_captures: ["a", "b"],
  runnerName: "dummy",
});

const sev = genIssueData({
  number: 1,
  state: "open",
  body: "not merge blocking",
  labels: ["ci: sev"],
});

const mergeBlockingSev = genIssueData({
  number: 2,
  state: "open",
  labels: ["merge blocking", "ci: sev"],
});

const closedSev = genIssueData({
  number: 3,
  state: "closed",
  labels: ["ci: sev"],
});

function constructResultsCommentHelper({
  pending = 3,
  failedJobs = [],
  flakyJobs = [],
  brokenTrunkJobs = [],
  unstableJobs = [],
  sha = "random sha",
  merge_base = "random_merge_base_sha",
  merge_base_date = "2023-08-08 06:03:21",
  hudBaseUrl = HUD_URL,
  owner = "pytorch",
  repo = "pytorch",
  prNumber = 123,
}: {
  pending?: number;
  failedJobs?: RecentWorkflowsData[];
  flakyJobs?: RecentWorkflowsData[];
  brokenTrunkJobs?: RecentWorkflowsData[];
  unstableJobs?: RecentWorkflowsData[];
  sha?: string;
  merge_base?: string;
  merge_base_date?: string;
  hudBaseUrl?: string;
  owner?: string;
  repo?: string;
  prNumber?: number;
}) {
  return updateDrciBot.constructResultsComment(
    pending,
    failedJobs,
    flakyJobs,
    brokenTrunkJobs,
    unstableJobs,
    new Map(),
    new Map(),
    new Map(),
    sha,
    merge_base,
    merge_base_date,
    hudBaseUrl,
    owner,
    repo,
    prNumber
  );
}

describe("Update Dr. CI Bot Unit Tests", () => {
  beforeEach(() => {
    const mock = jest.spyOn(drciUtils, "hasSimilarFailures");
    mock.mockImplementation(() => Promise.resolve(undefined));

    const mockJobUtils = jest.spyOn(jobUtils, "hasS3Log");
    mockJobUtils.mockImplementation(() => Promise.resolve(true));

    const mockfetchPR = jest.spyOn(fetchPR, "default");
    mockfetchPR.mockImplementation(() =>
      Promise.resolve({
        title: "A mock pull request",
        body: "Anything goes. Fixes #66",
        shas: [],
      })
    );
  });

  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  test("Check that constructResultsComment works correctly", async () => {
    const originalWorkflows = [
      successfulA,
      pendingA,
      failedB,
      failedA,
      failedC,
    ];
    const workflowsByPR = await updateDrciBot.reorganizeWorkflows(
      "pytorch",
      "pytorch",
      originalWorkflows
    );
    const pr_1001 = workflowsByPR.get(1001)!;
    const { pending, failedJobs } = await updateDrciBot.getWorkflowJobsStatuses(
      pr_1001,
      [],
      new Map()
    );
    const failureInfo = constructResultsCommentHelper({
      pending,
      failedJobs,
      sha: pr_1001.head_sha,
    });
    const failedJobName = failedA.name!;

    expect(failureInfo.includes("3 New Failures, 1 Pending")).toBeTruthy();
    expect(failureInfo.includes(failedJobName)).toBeTruthy();
    const expectedFailureOrder = `
* [something](${HUD_URL}/pr/pytorch/pytorch/123#1) ([gh](a))
    \`cde\`
* [somethingA](${HUD_URL}/pr/pytorch/pytorch/123#1) ([gh](a))
    \`mind blown\`
* [z-docs / build-docs (cpp)](${HUD_URL}/pr/pytorch/pytorch/123#1) ([gh](a))
    \`bababa\``;
    expect(failureInfo.includes(expectedFailureOrder)).toBeTruthy();
  });

  test("Check that reorganizeWorkflows works correctly", async () => {
    const originalWorkflows = [successfulA, pendingA, failedA];
    const workflowsByPR = await updateDrciBot.reorganizeWorkflows(
      "pytorch",
      "pytorch",
      originalWorkflows
    );
    const pr_1001 = workflowsByPR.get(1001)!;
    const pr_1000 = workflowsByPR.get(1000)!;

    expect(workflowsByPR.size).toBe(2);
    expect(pr_1000.jobs.length).toBe(1);
    expect(pr_1001.jobs.length).toBe(2);
  });

  test("Check that getWorkflowJobsStatuses works correctly", async () => {
    const originalWorkflows = [successfulA, pendingA, failedA];
    const workflowsByPR = await updateDrciBot.reorganizeWorkflows(
      "pytorch",
      "pytorch",
      originalWorkflows
    );
    const pr_1001 = workflowsByPR.get(1001)!;
    const { pending, failedJobs } = await updateDrciBot.getWorkflowJobsStatuses(
      pr_1001,
      [],
      new Map()
    );

    expect(pending).toBe(1);
    expect(failedJobs.length).toBe(1);
  });

  test("Check that dr ci comment is correctly formed", async () => {
    const comment = formDrciComment(successfulA.pr_number!);
    expect(comment.includes(DRCI_COMMENT_START)).toBeTruthy();
    expect(
      comment.includes("See artifacts and rendered test results")
    ).toBeTruthy();
    expect(
      comment.includes("Need help or want to give feedback on the CI?")
    ).toBeTruthy();
    expect(comment.includes(OH_URL)).toBeTruthy();
    expect(comment.includes(DOCS_URL)).toBeTruthy();
  });

  test("Make dr ci comment with failures", async () => {
    const originalWorkflows = [successfulA, pendingA, failedA];
    const workflowsByPR = await updateDrciBot.reorganizeWorkflows(
      "pytorch",
      "pytorch",
      originalWorkflows
    );
    const pr_1001 = workflowsByPR.get(1001)!;
    const { pending, failedJobs } = await updateDrciBot.getWorkflowJobsStatuses(
      pr_1001,
      [],
      new Map()
    );

    const failureInfo = constructResultsCommentHelper({
      pending,
      failedJobs,
      sha: pr_1001.head_sha,
    });
    const comment = formDrciComment(1001, "pytorch", "pytorch", failureInfo);
    expect(comment.includes("1 New Failure, 1 Pending")).toBeTruthy();
    expect(comment.includes("Helpful Links")).toBeTruthy();
    expect(
      comment.includes("This comment was automatically generated by Dr. CI")
    ).toBeTruthy();
  });

  test("test getActiveSevs function", async () => {
    expect(
      formDrciSevBody(getActiveSEVs([sev, closedSev])).includes(
        "## :heavy_exclamation_mark: 1 Active SEVs"
      )
    ).toBeTruthy();
    expect(
      formDrciSevBody(getActiveSEVs([sev, mergeBlockingSev])).includes(
        "## :heavy_exclamation_mark: 1 Merge Blocking SEVs"
      )
    ).toBeTruthy();
    expect(formDrciSevBody(getActiveSEVs([closedSev])) === "").toBeTruthy();
  });

  test("test form dr ci comment with sevs", async () => {
    const originalWorkflows = [successfulA, pendingA, failedA];
    const workflowsByPR = await updateDrciBot.reorganizeWorkflows(
      "pytorch",
      "pytorch",
      originalWorkflows
    );
    const pr_1001 = workflowsByPR.get(1001)!;
    const { pending, failedJobs } = await updateDrciBot.getWorkflowJobsStatuses(
      pr_1001,
      [],
      new Map()
    );

    const failureInfo = constructResultsCommentHelper({
      pending,
      failedJobs,
      sha: pr_1001.head_sha,
    });
    const comment = formDrciComment(
      1001,
      "pytorch",
      "pytorch",
      failureInfo,
      formDrciSevBody(getActiveSEVs([sev, mergeBlockingSev]))
    );
    expect(comment.includes("## :link: Helpful Links")).toBeTruthy();
    expect(
      comment.includes("## :heavy_exclamation_mark: 1 Merge Blocking SEVs")
    ).toBeTruthy();
    expect(comment.includes("## :x: 1 New Failure, 1 Pending")).toBeTruthy();
  });

  test("test that the result of the latest retry is used (success)", async () => {
    const originalWorkflows = [
      successfulA,
      pendingA,
      failedA,
      failedASuccessfulRetry,
    ];
    const workflowsByPR = await updateDrciBot.reorganizeWorkflows(
      "pytorch",
      "pytorch",
      originalWorkflows
    );
    const pr_1001 = workflowsByPR.get(1001)!;
    const { pending, failedJobs } = await updateDrciBot.getWorkflowJobsStatuses(
      pr_1001,
      [],
      new Map()
    );
    const failureInfo = constructResultsCommentHelper({
      pending,
      failedJobs,
      sha: pr_1001.head_sha,
    });
    const comment = formDrciComment(1001, "pytorch", "pytorch", failureInfo);
    expect(comment.includes("## :link: Helpful Links")).toBeTruthy();
    expect(
      comment.includes("## :hourglass_flowing_sand: No Failures, 1 Pending")
    ).toBeTruthy();
    expect(comment.includes(":green_heart:")).toBeTruthy();
  });

  test("test that the result of the latest retry is used (failure)", async () => {
    const originalWorkflows = [
      successfulA,
      pendingA,
      failedA,
      failedASuccessfulRetry,
      failedAFailedRetry,
    ];
    const workflowsByPR = await updateDrciBot.reorganizeWorkflows(
      "pytorch",
      "pytorch",
      originalWorkflows
    );
    const pr_1001 = workflowsByPR.get(1001)!;
    const { pending, failedJobs } = await updateDrciBot.getWorkflowJobsStatuses(
      pr_1001,
      [],
      new Map()
    );
    const failureInfo = constructResultsCommentHelper({
      pending,
      failedJobs,
      sha: pr_1001.head_sha,
    });
    const comment = formDrciComment(1001, "pytorch", "pytorch", failureInfo);
    expect(comment.includes("## :link: Helpful Links")).toBeTruthy();
    expect(comment.includes("## :x: 1 New Failure, 1 Pending")).toBeTruthy();
  });

  test("test flaky, broken trunk, and unstable jobs are filtered out", async () => {
    const originalWorkflows = [failedA, failedB, unstableA, unstableB];
    const workflowsByPR = await updateDrciBot.reorganizeWorkflows(
      "pytorch",
      "pytorch",
      originalWorkflows
    );
    const mockUnstableIssues: IssueData[] = [
      genIssueData({
        title: "UNSTABLE trunk / test-coreml-delegate / macos-job",
      }),
    ];
    const pr_1001 = workflowsByPR.get(1001)!;

    const { failedJobs, brokenTrunkJobs, flakyJobs, unstableJobs } =
      await updateDrciBot.getWorkflowJobsStatuses(
        pr_1001,
        [{ name: failedB.name!, captures: failedB.failure_captures }],
        new Map().set(failedA.name, [failedA]),
        [],
        mockUnstableIssues
      );
    expect(failedJobs.length).toBe(0);
    expect(brokenTrunkJobs.length).toBe(1);
    expect(flakyJobs.length).toBe(1);
    expect(unstableJobs.length).toBe(2);
  });

  test(" test flaky rule regex", async () => {
    const originalWorkflows = [
      failedA, // failure
      failedG, // failure, matches rule, but is build -> failure
      failedH, // failure, matches rule -> flaky
      failedI, // failure, matches rule -> flaky
    ];
    const workflowsByPR = await updateDrciBot.reorganizeWorkflows(
      "pytorch",
      "pytorch",
      originalWorkflows
    );
    const pr_1001 = workflowsByPR.get(1001)!;
    const { failedJobs, brokenTrunkJobs, flakyJobs, unstableJobs } =
      await updateDrciBot.getWorkflowJobsStatuses(
        pr_1001,
        [
          {
            name: "win",
            captures: [
              "The process cannot access the file .+ because it is being used by another process",
            ],
          },
          {
            name: "linux",
            captures: ["The runner has received a shutdown signal"],
          },
          {
            name: "macos",
            captures: ["test_torchinductor_opinfo .+ Received signal: SIGSEGV"],
          },
        ],
        new Map()
      );
    expect(failedJobs.length).toBe(2);
    expect(brokenTrunkJobs.length).toBe(0);
    expect(flakyJobs.length).toBe(2);
    expect(unstableJobs.length).toBe(0);
  });

  test("test shard id and suffix in job name are handled correctly", async () => {
    const originalWorkflows = [failedA, failedD, failedF];
    const workflowsByPR = await updateDrciBot.reorganizeWorkflows(
      "pytorch",
      "pytorch",
      originalWorkflows
    );
    const pr_1001 = workflowsByPR.get(1001)!;

    const baseJobs = new Map();
    baseJobs.set(removeJobNameSuffix(failedD.name!), [failedE]);
    baseJobs.set(removeJobNameSuffix(failedF.name!), [unstableA]);

    const { failedJobs, brokenTrunkJobs, flakyJobs, unstableJobs } =
      await updateDrciBot.getWorkflowJobsStatuses(pr_1001, [], baseJobs);
    expect(failedJobs.length).toBe(1);
    expect(brokenTrunkJobs.length).toBe(2);
    expect(flakyJobs.length).toBe(0);
    expect(unstableJobs.length).toBe(0);
  });

  test("test flaky, broken trunk, and unstable jobs are included in the comment", async () => {
    const failureInfoComment = constructResultsCommentHelper({
      pending: 1,
      failedJobs: [failedA],
      flakyJobs: [failedB],
      brokenTrunkJobs: [failedC],
      unstableJobs: [unstableA],
      merge_base: "random base sha",
    });
    const expectToContain = [
      "1 New Failure, 1 Pending, 3 Unrelated Failures",
      "The following job has failed",
      "The following job failed but was likely due to flakiness present on trunk",
      "The following job failed but was present on the merge base",
      "The following job is marked as unstable",
      failedA.name,
      failedB.name,
      failedC.name,
      unstableA.name,
    ];
    expect(
      expectToContain.every((s) => failureInfoComment.includes(s))
    ).toBeTruthy();
  });

  test("test pending unstable job", async () => {
    // Test that a pending unstable job gets included in the comment as
    // unstable, but doesn't count as failed in the overall count
    const failureInfoComment = constructResultsCommentHelper({
      pending: 1,
      failedJobs: [failedA],
      flakyJobs: [failedB],
      brokenTrunkJobs: [failedC],
      unstableJobs: [{ ...unstableA, conclusion: "", completed_at: TIME_0 }],
      merge_base: "random base sha",
    });
    const expectToContain = [
      "1 New Failure, 1 Pending, 2 Unrelated Failures",
      "The following job has failed",
      "The following job failed but was likely due to flakiness present on trunk",
      "The following job failed but was present on the merge base",
      "The following job is marked as unstable",
      failedA.name,
      failedB.name,
      failedC.name,
      unstableA.name,
    ];
    expect(
      expectToContain.every((s) => failureInfoComment.includes(s))
    ).toBeTruthy();
  });

  test("test flaky, broken trunk, unstable jobs don't affect the Dr. CI icon", async () => {
    const failureInfoComment = constructResultsCommentHelper({
      pending: 1,
      flakyJobs: [failedB],
      brokenTrunkJobs: [failedC],
      unstableJobs: [unstableA],
    });

    const expectToContain = [
      ":hourglass_flowing_sand:",
      "1 Pending, 3 Unrelated Failures",
      failedB.name,
      failedC.name,
      unstableA.name,
    ];
    expect(
      expectToContain.every((s) => failureInfoComment.includes(s!))
    ).toBeTruthy();
  });

  test("test merge base time shows up in results comment", async () => {
    const failureInfoComment = constructResultsCommentHelper({
      sha: "sha",
      merge_base: "merge_base",
      merge_base_date: "2023-08-08 06:03:21",
    });
    expect(
      failureInfoComment.includes("commit sha with merge base merge_base")
    ).toBeTruthy();
    expect(
      failureInfoComment.includes(
        "https://img.shields.io/date/1691474601?label=&color=FFFFFF&style=flat-square"
      )
    ).toBeTruthy();
  });

  test("test bad merge base time is handled correctly", async () => {
    const failureInfoComment = constructResultsCommentHelper({
      sha: "sha",
      merge_base: "merge_base",
      merge_base_date: "definitely not a timestamp",
    });
    expect(
      failureInfoComment.includes("commit sha with merge base merge_base")
    ).toBeTruthy();
    expect(!failureInfoComment.includes("img")).toBeTruthy();
  });

  test("test formDrciHeader for pytorch/pytorch", async () => {
    const header = formDrciHeader("pytorch", "pytorch", 42);

    expect(header.includes("hud.pytorch.org/pr/42")).toBeTruthy();
    expect(header.includes("Python docs built from this PR")).toBeTruthy();
    expect(header.includes("C++ docs built from this PR")).toBeTruthy();
    expect(header.includes("bot commands wiki")).toBeTruthy();
  });

  test("test formDrciHeader for pytorch/vision", async () => {
    const header = formDrciHeader("pytorch", "vision", 42);

    expect(
      header.includes("hud.pytorch.org/pr/pytorch/vision/42")
    ).toBeTruthy();
    expect(header.includes("Python docs built from this PR")).toBeTruthy();
    expect(header.includes("C++ docs built from this PR")).toBeFalsy();
    expect(header.includes("bot commands wiki")).toBeFalsy();
  });

  test("test getBaseCommitJobs", async () => {
    const originalWorkflows = [failedA, failedB];
    const workflowsByPR = await updateDrciBot.reorganizeWorkflows(
      "pytorch",
      "pytorch",
      originalWorkflows
    );
    const mock = jest.spyOn(fetchRecentWorkflows, "fetchFailedJobsFromCommits");
    mock.mockImplementation(() => Promise.resolve([failedA, failedB]));

    const baseCommitJobs = await updateDrciBot.getBaseCommitJobs(workflowsByPR);
    expect(baseCommitJobs).toMatchObject(
      new Map().set(
        failedA.head_sha,
        new Map().set(failedA.name, [failedA]).set(failedB.name, [failedB])
      )
    );

    const { pending, failedJobs, flakyJobs, brokenTrunkJobs, unstableJobs } =
      await updateDrciBot.getWorkflowJobsStatuses(
        workflowsByPR.get(1001)!,
        [],
        baseCommitJobs.get(failedA.head_sha)!
      );
    expect(failedJobs.length).toBe(0);
    expect(brokenTrunkJobs.length).toBe(2);
    expect(flakyJobs.length).toBe(0);
    expect(unstableJobs.length).toBe(0);
  });

  test("test similar failures marked as flaky", async () => {
    const mock = jest.spyOn(drciUtils, "hasSimilarFailures");
    mock.mockImplementation(() =>
      Promise.resolve(
        getDummyJob({
          id: 1,
          completed_at: "2022-07-13 19:34:03",
          html_url: "abcdefg",
          head_sha: "abcdefg",
          failure_captures: [],
        })
      )
    );

    const originalWorkflows = [failedB];
    const workflowsByPR = await updateDrciBot.reorganizeWorkflows(
      "pytorch",
      "pytorch",
      originalWorkflows
    );
    const pr_1001 = workflowsByPR.get(1001)!;
    const { failedJobs, brokenTrunkJobs, flakyJobs, unstableJobs } =
      await updateDrciBot.getWorkflowJobsStatuses(pr_1001, [], new Map());
    expect(failedJobs.length).toBe(0);
    expect(brokenTrunkJobs.length).toBe(0);
    expect(flakyJobs.length).toBe(1);
    expect(unstableJobs.length).toBe(0);
  });

  test("test jobs excluded from flaky detection", async () => {
    const excludedFailure = {
      id: 1,
      runnerName: "dummy",
      name: "Lint / lintrunner / linux-job",
      conclusion: "failure",
      completed_at: "2023-10-13 15:00:48",
      html_url: "a",
      head_sha: "abcdefg",
      pr_number: 1001,
      failure_captures: [">>> Lint for torch/_dynamo/output_graph.py:"],
      failure_lines: [">>> Lint for torch/_dynamo/output_graph.py:"],
    };

    const originalWorkflows = [getDummyJob(excludedFailure)];
    const workflowsByPR = await updateDrciBot.reorganizeWorkflows(
      "pytorch",
      "pytorch",
      originalWorkflows
    );

    const pr_1001 = workflowsByPR.get(1001)!;
    const { pending, failedJobs, flakyJobs, brokenTrunkJobs, unstableJobs } =
      await updateDrciBot.getWorkflowJobsStatuses(pr_1001, [], new Map());

    expect(failedJobs.length).toBe(1);
    expect(brokenTrunkJobs.length).toBe(0);
    expect(flakyJobs.length).toBe(0);
    expect(unstableJobs.length).toBe(0);
  });

  test("test failed workflows go away if theres a new one", async () => {
    const failedWorkflow = getDummyJob({
      workflowId: 0,
      id: 1,
      name: "weird name",
      conclusion: "failure",
    });
    const newWorkflow = getDummyJob({
      workflowId: 0,
      id: 2,
      name: "correct name",
    });

    const originalWorkflows = [failedWorkflow, newWorkflow];
    const workflowsByPR = await updateDrciBot.reorganizeWorkflows(
      "pytorch",
      "pytorch",
      originalWorkflows
    );

    const pr_1001 = workflowsByPR.get(1001)!;
    const { pending, failedJobs, flakyJobs, brokenTrunkJobs, unstableJobs } =
      await updateDrciBot.getWorkflowJobsStatuses(pr_1001, [], new Map());

    expect(pending).toBe(0);
    expect(failedJobs.length).toBe(0);
    expect(brokenTrunkJobs.length).toBe(0);
    expect(flakyJobs.length).toBe(0);
    expect(unstableJobs.length).toBe(0);
  });

  test("test new failed workflow overrides old succeeding workflow", async () => {
    const newFailedWorkflow = getDummyJob({
      workflowId: 0,
      id: 2,
      name: "weird name",
      conclusion: "failure",
    });
    const oldSuccessfulWorkflow = getDummyJob({
      workflowId: 0,
      id: 1,
      name: "correct name",
    });
    const oldSuccessfulWorkflowsJobs = [
      getDummyJob({
        workflowId: 1,
        id: 3,
        name: "correct name",
      }),
      getDummyJob({
        workflowId: 1,
        id: 4,
        name: "correct name",
      }),
    ];

    const originalWorkflows = [
      newFailedWorkflow,
      oldSuccessfulWorkflow,
      ...oldSuccessfulWorkflowsJobs,
    ];
    const workflowsByPR = await updateDrciBot.reorganizeWorkflows(
      "pytorch",
      "pytorch",
      originalWorkflows
    );

    const pr_1001 = workflowsByPR.get(1001)!;
    const { pending, failedJobs, flakyJobs, brokenTrunkJobs, unstableJobs } =
      await updateDrciBot.getWorkflowJobsStatuses(pr_1001, [], new Map());

    expect(pending).toBe(0);
    expect(failedJobs.length).toBe(1);
    expect(brokenTrunkJobs.length).toBe(0);
    expect(flakyJobs.length).toBe(0);
    expect(unstableJobs.length).toBe(0);
  });
});
