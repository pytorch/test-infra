import * as labelerConfigUtils from "lib/bot/labelerConfigUtils";
import * as botUtils from "lib/bot/utils";
import { TIME_0 } from "lib/bot/utils";
import * as clickhouse from "lib/clickhouse";
import * as crcrAllowlist from "lib/crcrAllowlist";
import { CrcrAllowlist } from "lib/crcrAllowlist";
import * as drciUtils from "lib/drciUtils";
import {
  DOCS_URL,
  DRCI_COMMENT_START,
  formDrciComment,
  formDrciHeader,
  formDrciSevBody,
  getActiveSEVs,
  HUD_URL,
} from "lib/drciUtils";
import * as fetchPR from "lib/fetchPR";
import * as fetchRecentWorkflows from "lib/fetchRecentWorkflows";
import * as greenlightComment from "lib/greenlight/greenlightComment";
import * as jobUtils from "lib/jobUtils";
import { removeJobNameSuffix } from "lib/jobUtils";
import { IssueData, PRandJobs, RecentWorkflowsData } from "lib/types";
import nock from "nock";
import * as updateDrciBot from "../pages/api/drci/drci";
import * as utils from "./utils";
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

// Workflow awaiting approval from maintainer
const awaitingApprovalA = getDummyJob({
  name: "pull / linux-build",
  conclusion: "action_required",
  completed_at: "2022-07-13 19:34:03",
  html_url: "a",
  head_sha: "abcdefg",
  id: 1,
  pr_number: 1001,
  failure_lines: [],
  failure_captures: [],
  runnerName: "",
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
  unknownJobs = [],
  awaitingApprovalJobs = [],
  crcrL3Jobs = [],
  aiNotRelatedJobs = [],
  sha = "random sha",
  merge_base = "random_merge_base_sha",
  merge_base_date = "2023-08-08 06:03:21",
  hudBaseUrl = HUD_URL,
  owner = "pytorch",
  repo = "pytorch",
  prNumber = 123,
  greenlightSection = "",
  failuresAbove,
}: {
  pending?: number;
  failedJobs?: RecentWorkflowsData[];
  flakyJobs?: RecentWorkflowsData[];
  brokenTrunkJobs?: RecentWorkflowsData[];
  unstableJobs?: RecentWorkflowsData[];
  unknownJobs?: RecentWorkflowsData[];
  awaitingApprovalJobs?: RecentWorkflowsData[];
  crcrL3Jobs?: RecentWorkflowsData[];
  aiNotRelatedJobs?: RecentWorkflowsData[];
  sha?: string;
  merge_base?: string;
  merge_base_date?: string;
  hudBaseUrl?: string;
  owner?: string;
  repo?: string;
  prNumber?: number;
  greenlightSection?: string;
  failuresAbove?: { sections: string; count: number };
}) {
  return updateDrciBot.constructResultsComment(
    pending,
    failedJobs,
    flakyJobs,
    brokenTrunkJobs,
    unstableJobs,
    unknownJobs,
    awaitingApprovalJobs,
    crcrL3Jobs,
    aiNotRelatedJobs,
    new Map(),
    new Map(),
    new Map(),
    sha,
    merge_base,
    merge_base_date,
    hudBaseUrl,
    owner,
    repo,
    prNumber,
    new Map(),
    greenlightSection,
    failuresAbove
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

  test("test the Green Light section is absent unless one is supplied", async () => {
    const failureInfoComment = constructResultsCommentHelper({
      pending: 1,
      failedJobs: [failedA],
    });
    expect(failureInfoComment).not.toContain("GREEN LIGHT");
  });

  test("test the Green Light section renders above the failure sections", async () => {
    const greenlightSection =
      "\n<details open><summary><b>GREEN LIGHT</b> - PR requires human review:</summary><p>\n\nnope\n\n</p></details>";
    const failureInfoComment = constructResultsCommentHelper({
      pending: 1,
      failedJobs: [failedA],
      flakyJobs: [failedB],
      greenlightSection,
    });

    expect(failureInfoComment).toContain(greenlightSection);
    // It is a PR-level verdict, so it must precede the per-bucket job lists but
    // still follow the merge-base preamble.
    expect(failureInfoComment.indexOf("GREEN LIGHT")).toBeGreaterThan(
      failureInfoComment.indexOf("As of commit")
    );
    expect(failureInfoComment.indexOf("GREEN LIGHT")).toBeLessThan(
      failureInfoComment.indexOf("The following job has failed")
    );
  });

  test("test the Green Light section renders on a PR with no failures", async () => {
    const failureInfoComment = constructResultsCommentHelper({
      pending: 0,
      greenlightSection: "\n<b>GREEN LIGHT</b> - all clear",
    });
    expect(failureInfoComment).toContain("No Failures");
    expect(failureInfoComment).toContain("GREEN LIGHT");
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

  test("test awaiting approval workflows show in comment", async () => {
    const failureInfoComment = constructResultsCommentHelper({
      pending: 0,
      awaitingApprovalJobs: [awaitingApprovalA],
    });

    const expectToContain = [
      ":warning:",
      "1 Awaiting Approval",
      "AWAITING APPROVAL",
      "workflow needs approval before CI can run",
      awaitingApprovalA.name,
    ];
    const expectNotToContain = ["No Failures", ":green_heart:"];

    expect(
      expectToContain.every((s) => failureInfoComment.includes(s!))
    ).toBeTruthy();
    expect(
      expectNotToContain.every((s) => !failureInfoComment.includes(s!))
    ).toBeTruthy();
  });

  test("test awaiting approval with failures shows both", async () => {
    const failureInfoComment = constructResultsCommentHelper({
      pending: 1,
      failedJobs: [failedA],
      awaitingApprovalJobs: [awaitingApprovalA],
    });

    const expectToContain = [
      "1 Awaiting Approval",
      "1 New Failure",
      "1 Pending",
      "AWAITING APPROVAL",
      awaitingApprovalA.name,
      failedA.name,
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

  test("test formDrciHeader links Auto PR Triage runs by head branch", async () => {
    const header = formDrciHeader("pytorch", "pytorch", 42, "fix/foo-1.2_x", [
      "open source",
    ]);

    expect(header).toContain(
      "* :robot: See [Auto PR Triage runs for this PR](https://github.com/pytorch/pytorch/actions/workflows/auto-pr-triage.yml?query=branch%3Afix%2Ffoo-1.2_x%20-is%3Askipped%20-is%3Acancelled)\n"
    );
    expect(header).toContain("bot commands wiki");
  });

  test("test formDrciHeader omits the Auto PR Triage link without the open source label", async () => {
    for (const labels of [[], ["triaged", "ciflow/trunk"]]) {
      const header = formDrciHeader(
        "pytorch",
        "pytorch",
        42,
        "fix-foo",
        labels
      );
      expect(header).not.toContain("Auto PR Triage");
    }
  });

  test("test formDrciHeader omits the Auto PR Triage link without a plain head branch", async () => {
    for (const headRef of ["", "fix)(evil", "a b", "x]\n* injected"]) {
      const header = formDrciHeader("pytorch", "pytorch", 42, headRef, [
        "open source",
      ]);
      expect(header).not.toContain("Auto PR Triage");
    }
    expect(
      formDrciHeader("pytorch", "vision", 42, "fix-foo", ["open source"])
    ).not.toContain("Auto PR Triage");
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

  test("test getBaseCommitJobNames groups names by sha and strips suffix", async () => {
    const originalWorkflows = [failedA, failedD];
    const workflowsByPR = await updateDrciBot.reorganizeWorkflows(
      "pytorch",
      "pytorch",
      originalWorkflows
    );
    const mock = jest.spyOn(fetchRecentWorkflows, "fetchJobNamesFromCommits");
    mock.mockImplementation(() =>
      Promise.resolve([
        { head_sha: failedA.head_sha!, name: failedA.name! },
        // Different shard than failedD; should collapse to the same key
        { head_sha: failedA.head_sha!, name: failedE.name! },
      ])
    );

    const baseJobNames = await updateDrciBot.getBaseCommitJobNames(
      workflowsByPR
    );
    const names = baseJobNames.get(failedA.head_sha!)!;
    expect(names.has(failedA.name!)).toBeTruthy();
    expect(names.has(removeJobNameSuffix(failedD.name!))).toBeTruthy();
    expect(names.size).toBe(2);
  });

  test("job that did not run on merge base is classified as Unknown", async () => {
    const originalWorkflows = [failedC];
    const workflowsByPR = await updateDrciBot.reorganizeWorkflows(
      "pytorch",
      "pytorch",
      originalWorkflows
    );
    const pr_1001 = workflowsByPR.get(1001)!;
    const {
      failedJobs,
      brokenTrunkJobs,
      flakyJobs,
      unstableJobs,
      unknownJobs,
    } = await updateDrciBot.getWorkflowJobsStatuses(
      pr_1001,
      [],
      new Map(),
      [],
      [],
      [],
      [],
      new Set() // base ran no jobs at all -> failedC didn't run on base
    );
    expect(unknownJobs.length).toBe(1);
    expect(unknownJobs[0].name).toBe(failedC.name);
    expect(failedJobs.length).toBe(0);
    expect(brokenTrunkJobs.length).toBe(0);
    expect(flakyJobs.length).toBe(0);
    expect(unstableJobs.length).toBe(0);
  });

  test("job that ran on merge base and passed stays a New Failure", async () => {
    const originalWorkflows = [failedC];
    const workflowsByPR = await updateDrciBot.reorganizeWorkflows(
      "pytorch",
      "pytorch",
      originalWorkflows
    );
    const pr_1001 = workflowsByPR.get(1001)!;
    const baseJobNames = new Set<string>([removeJobNameSuffix(failedC.name!)]);
    const {
      failedJobs,
      brokenTrunkJobs,
      flakyJobs,
      unstableJobs,
      unknownJobs,
    } = await updateDrciBot.getWorkflowJobsStatuses(
      pr_1001,
      [],
      new Map(), // no failed jobs on base
      [],
      [],
      [],
      [],
      baseJobNames
    );
    expect(unknownJobs.length).toBe(0);
    expect(failedJobs.length).toBe(1);
    expect(brokenTrunkJobs.length).toBe(0);
    expect(flakyJobs.length).toBe(0);
    expect(unstableJobs.length).toBe(0);
  });

  test("Unknown failures are rendered in their own section and excluded from New Failures count", async () => {
    const failureInfoComment = constructResultsCommentHelper({
      pending: 0,
      failedJobs: [failedA],
      unknownJobs: [failedC],
    });
    expect(failureInfoComment.includes("1 New Failure")).toBeTruthy();
    expect(failureInfoComment.includes("1 Unclassified Failure")).toBeTruthy();
    expect(failureInfoComment.includes("UNCLASSIFIED FAILURE")).toBeTruthy();
    expect(
      failureInfoComment.includes(
        "DrCI could not classify the following job because the workflow did not run on the merge base"
      )
    ).toBeTruthy();
    expect(failureInfoComment.includes(failedC.name!)).toBeTruthy();
  });

  test("Unclassified failures alone surface as a failure status, not success", async () => {
    const failureInfoComment = constructResultsCommentHelper({
      pending: 0,
      unknownJobs: [failedC],
    });
    expect(failureInfoComment.includes(":x:")).toBeTruthy();
    expect(failureInfoComment.includes("No Failures")).toBeFalsy();
    expect(failureInfoComment.includes(":green_heart:")).toBeFalsy();
    expect(failureInfoComment.includes("1 Unclassified Failure")).toBeTruthy();
    // Section is expanded (not collapsed)
    expect(
      failureInfoComment.includes("<details open><summary><b>UNCLASSIFIED")
    ).toBeTruthy();
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

describe("classifyCrcrJobs", () => {
  // Mirrors the shape of pytorch/pytorch's real .github/allowlist.yml.
  const allowlist = CrcrAllowlist.fromYaml(`
L3:
  crcr-test:
    pytorch/crcr-test: [oncall1]
  npu:
    Ascend/pytorch: [oncall2]
L4:
  - org/l4-repo: oncall3
`);

  function crcrJob(
    overrides: Partial<RecentWorkflowsData>
  ): RecentWorkflowsData {
    return getDummyJob({
      name: "crcr/pytorch/crcr-test/CRCR L3 CI/test-L3-xfail-checkrun-creation",
      downstreamLevel: "L3",
      downstreamRepo: "pytorch/crcr-test",
      conclusion: "failure",
      ...overrides,
    });
  }

  // Regression test for pytorch/test-infra#8879: crcr-test dispatches on
  // every PR (shadow traffic) and even self-tests post-merge on PRs that
  // never carried its label, but none of that should resurface on a PR whose
  // labels never opted into ciflow/crcr/crcr-test.
  test("drops an L3 job when the PR lacks the matching ciflow/crcr/<device> label", () => {
    const job = crcrJob({});
    const { crcrL3Jobs, crcrL4Jobs } = updateDrciBot.classifyCrcrJobs(
      [job],
      ["ciflow/crcr/npu"], // a different device's label, not crcr-test's
      allowlist
    );
    expect(crcrL3Jobs).toEqual([]);
    expect(crcrL4Jobs).toEqual([]);
  });

  test("keeps an L3 job when the PR carries the matching ciflow/crcr/<device> label", () => {
    const job = crcrJob({});
    const { crcrL3Jobs, crcrL4Jobs } = updateDrciBot.classifyCrcrJobs(
      [job],
      ["ciflow/crcr/crcr-test"],
      allowlist
    );
    expect(crcrL3Jobs).toEqual([job]);
    expect(crcrL4Jobs).toEqual([]);
  });

  test("always keeps L4 jobs regardless of labels", () => {
    const job = crcrJob({
      downstreamLevel: "L4",
      downstreamRepo: "org/l4-repo",
    });
    const { crcrL3Jobs, crcrL4Jobs } = updateDrciBot.classifyCrcrJobs(
      [job],
      [],
      allowlist
    );
    expect(crcrL3Jobs).toEqual([]);
    expect(crcrL4Jobs).toEqual([job]);
  });

  test("drops L3 jobs when the allowlist failed to load", () => {
    const job = crcrJob({});
    const { crcrL3Jobs } = updateDrciBot.classifyCrcrJobs(
      [job],
      ["ciflow/crcr/crcr-test"],
      null
    );
    expect(crcrL3Jobs).toEqual([]);
  });
});

describe("isDrciGreen", () => {
  const cancelled = getDummyJob({
    name: "cancelledJob",
    conclusion: "cancelled",
  });
  const cases: [
    string,
    Parameters<typeof constructResultsCommentHelper>[0],
    boolean
  ][] = [
    ["nothing ran yet", { pending: 0 }, true],
    [
      "only unrelated failures",
      { pending: 0, flakyJobs: [failedA], brokenTrunkJobs: [failedB] },
      true,
    ],
    ["pending jobs", { pending: 1 }, false],
    ["a new failure", { pending: 0, failedJobs: [failedA] }, false],
    ["a cancelled job", { pending: 0, failedJobs: [cancelled] }, false],
    ["an unclassified failure", { pending: 0, unknownJobs: [failedA] }, false],
    [
      "a workflow awaiting approval",
      { pending: 0, awaitingApprovalJobs: [failedA] },
      false,
    ],
  ];

  test.each(cases)("%s", (_name, input, expected) => {
    const green = updateDrciBot.isDrciGreen({
      pending: input.pending ?? 3,
      failedJobs: input.failedJobs ?? [],
      unknownJobs: input.unknownJobs ?? [],
      awaitingApprovalJobs: input.awaitingApprovalJobs ?? [],
    });
    expect(green).toBe(expected);
    // The headline icon is the same decision
    expect(
      constructResultsCommentHelper(input).includes(":white_check_mark:")
    ).toBe(expected);
  });
});

describe("isCiGoodForReview", () => {
  const startupFailure = getDummyJob({
    name: "pull / linux-test",
    conclusion: "startup_failure",
  });
  const cases: [
    string,
    Partial<Parameters<typeof updateDrciBot.isCiGoodForReview>[0]>,
    boolean
  ][] = [
    ["nothing failed", {}, true],
    [
      "a workflow awaiting approval",
      { awaitingApprovalJobs: [awaitingApprovalA] },
      true,
    ],
    [
      "a workflow that failed to start",
      { awaitingApprovalJobs: [startupFailure] },
      false,
    ],
    [
      "a workflow awaiting approval and a new failure",
      { awaitingApprovalJobs: [awaitingApprovalA], failedJobs: [failedA] },
      false,
    ],
    [
      "pending jobs",
      { pending: 1, awaitingApprovalJobs: [awaitingApprovalA] },
      false,
    ],
  ];

  test.each(cases)("%s", (_name, input, expected) => {
    expect(
      updateDrciBot.isCiGoodForReview({
        pending: 0,
        failedJobs: [],
        unknownJobs: [],
        awaitingApprovalJobs: [],
        ...input,
      })
    ).toBe(expected);
  });
});

const ciflowLabelerConfig = {
  "module: dynamo": ["torch/_dynamo/**"],
  "ciflow/inductor": ["torch/_dynamo/**"],
  "ciflow/mps": ["torch/mps/**"],
};
const link = (n: number) =>
  `[${n}](https://redirect.github.com/pytorch/pytorch/pull/${n})`;
const shaOf = (pr: number) => String(pr).padStart(40, "0");
const ABOVE_END = "<!-- drci-ciflow-above-end -->";
// A block as Dr.CI writes it on PR `lower` for the run of `label` on `cover`.
const aboveBlock = (
  cover: number,
  label: string,
  lower: number,
  count: number
) =>
  `<!-- drci-ciflow-above ${cover} ${label} ${shaOf(
    lower
  )} ${count} -->\n<details open><summary>${label} on ${cover}</summary></details>\n${ABOVE_END}`;

function ciflowJob(
  id: number,
  prNumber: number,
  headBranch: string,
  overrides: Partial<RecentWorkflowsData> = {}
) {
  return getDummyJob({
    id,
    name: `job ${id}`,
    conclusion: "failure",
    pr_number: prNumber,
    head_sha: shaOf(prNumber),
    head_sha_timestamp: "2026-10-29 10:00:00",
    head_branch: headBranch,
    failure_lines: ["boom"],
    ...overrides,
  });
}

// The cover's labels and the open PRs below it, nearest first: [number, files, labels].
function mockStackBelow(
  cover: number,
  labels: string[],
  below: [number, string[], string[]][]
) {
  const listing = [
    "Stack from [ghstack](https://github.com/ezyang/ghstack/tree/0.17.0) (oldest at bottom):",
    `* __->__ #${cover}`,
    ...below.map(([n]) => `* #${n}`),
  ].join("\n");
  const repository: any = {};
  const compared: any = {};
  below.forEach(([n, files, prLabels], i) => {
    repository[`pr${i}`] = {
      number: n,
      state: "OPEN",
      isDraft: false,
      isCrossRepository: false,
      headRefName: `gh/alice/${n}/head`,
      labels: { nodes: prLabels.map((name) => ({ name })) },
      changedFiles: files.length,
      files: { nodes: files.map((path) => ({ path })) },
    };
    compared[`c${i}`] = { compare: { behindBy: 0, status: "AHEAD" } };
  });
  const sameRepo = { full_name: "pytorch/pytorch" };
  return nock("https://api.github.com")
    .get(`/repos/pytorch/pytorch/pulls/${cover}`)
    .reply(200, {
      number: cover,
      body: listing,
      labels: labels.map((name) => ({ name })),
      head: { ref: `gh/alice/${cover}/head`, repo: sameRepo },
      base: { ref: "main", repo: sameRepo },
    })
    .post(
      "/graphql",
      (body) =>
        body.query.includes("StackPrFields") &&
        body.variables.n0 === below[0][0]
    )
    .reply(200, { data: { repository } })
    .post(
      "/graphql",
      (body) =>
        body.query.includes("compare(") &&
        body.variables.h0 === `refs/heads/gh/alice/${cover}/orig`
    )
    .reply(200, { data: { repository: compared } });
}

// fetchRecentWorkflows returns the jobs of the PRs it is asked for (of
// recentPrs when asked for none), and ClickHouse these Dr.CI comments: by PR,
// and every one with a line starting a block for the lookup of blocks.
function mockFetchedPrs(
  jobs: RecentWorkflowsData[],
  comments: { [pr: number]: string },
  recentPrs: number[] = []
) {
  jest
    .spyOn(fetchPR, "default")
    .mockResolvedValue({ title: "", body: "", shas: [] });
  jest
    .spyOn(clickhouse, "queryClickhouse")
    .mockImplementation(async (query, params: any) =>
      query.includes("drci-ciflow-above")
        ? Object.entries(comments)
            .filter(([, body]) => /^<!-- drci-ciflow-above \d+ /m.test(body))
            .map(([pr, body]) => ({
              issue_url: `https://api.github.com/repos/pytorch/pytorch/issues/${pr}`,
              body,
            }))
        : (params.prUrls ?? []).flatMap((url: string) => {
            const pr = parseInt(url.split("/").pop()!);
            return pr in comments
              ? [{ id: pr * 10, body: comments[pr], issue_url: url }]
              : [];
          })
    );
  return jest
    .spyOn(fetchRecentWorkflows, "fetchRecentWorkflows")
    .mockImplementation(async (_repo, prNumbers = []) => {
      const prs = prNumbers.length === 0 ? recentPrs : prNumbers;
      return jobs.filter((job) => prs.includes(job.pr_number));
    });
}

describe("getCiflowCoverage", () => {
  const octokit = utils.testOctokit();
  const empty = {
    coversBelow: new Map(),
    coveredBy: new Map(),
    walked: new Set(),
    failed: new Set(),
    stepFailed: false,
    noLabelerConfig: false,
  };
  const prsOf = (jobs: RecentWorkflowsData[]) =>
    updateDrciBot.reorganizeWorkflows("pytorch", "pytorch", jobs);
  const coverage = (
    workflowsByPR: Map<number, PRandJobs>,
    comments: Map<number, { id: number; body: string }>,
    fanOut: boolean,
    budgetMs?: number
  ) =>
    updateDrciBot.getCiflowCoverage(
      octokit,
      "pytorch",
      "pytorch",
      workflowsByPR,
      comments,
      fanOut,
      budgetMs
    );
  let loadConfig: jest.SpyInstance;

  beforeEach(() => {
    loadConfig = jest
      .spyOn(labelerConfigUtils, "loadLabelerConfig")
      .mockResolvedValue(ciflowLabelerConfig);
    jest.spyOn(clickhouse, "queryClickhouse").mockResolvedValue([]);
  });

  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  test("without a failing tag run, a single-PR run makes no call, and a scheduled run only looks up the PRs that show a block", async () => {
    const pulls = nock("https://api.github.com")
      .get(/\/pulls\//)
      .reply(200, {});
    const jobs = [
      ciflowJob(1, 13, "gh/alice/13/head"),
      ciflowJob(2, 13, "ciflow/inductor/33"),
      ciflowJob(3, 15, "gh/alice/15/head", { conclusion: "success" }),
    ];
    // 12 shows a block of a PR outside the run, and 15 is in the run already.
    const fetchSpy = mockFetchedPrs([], {
      12: aboveBlock(14, "ciflow/inductor", 12, 1),
      15: aboveBlock(13, "ciflow/inductor", 15, 1),
    });
    expect(await coverage(await prsOf(jobs), new Map(), false)).toEqual(empty);
    expect(clickhouse.queryClickhouse).not.toHaveBeenCalled();
    expect(await coverage(await prsOf(jobs), new Map(), true)).toEqual(empty);
    expect(clickhouse.queryClickhouse).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(loadConfig).not.toHaveBeenCalled();
    expect(pulls.isDone()).toBe(false);
  });

  test("a null config gives empty coverage; a config error, or a read past the budget, sets the failed flag", async () => {
    const pulls = nock("https://api.github.com")
      .get(/\/pulls\//)
      .reply(200, {});
    const jobs = [ciflowJob(1, 13, "ciflow/inductor/13")];
    loadConfig.mockResolvedValueOnce(null);
    expect(await coverage(await prsOf(jobs), new Map(), true)).toEqual({
      ...empty,
      noLabelerConfig: true,
    });
    const error = new Error("GitHub 502");
    loadConfig.mockRejectedValueOnce(error);
    jest.spyOn(console, "error").mockImplementation(() => {});
    expect(await coverage(await prsOf(jobs), new Map(), true)).toEqual({
      ...empty,
      stepFailed: true,
    });
    expect(console.error).toHaveBeenCalledWith(
      "could not read the labeler config of",
      "pytorch",
      "pytorch",
      "for ciflow coverage",
      error
    );
    loadConfig.mockReturnValueOnce(new Promise(() => {}));
    expect(await coverage(await prsOf(jobs), new Map(), false, 50)).toEqual({
      ...empty,
      stepFailed: true,
    });
    expect(console.error).toHaveBeenLastCalledWith(
      "could not read the labeler config of",
      "pytorch",
      "pytorch",
      "for ciflow coverage",
      expect.objectContaining({
        message: "reading the labeler config did not finish within 50 ms",
      })
    );
    expect(pulls.isDone()).toBe(false);
  });

  test("a raw failure of a config label qualifies; a pull_request run, a label outside the config or another PR's tag does not", async () => {
    const pulls = nock("https://api.github.com")
      .get(/\/pulls\/(14|15|16)$/)
      .reply(200, {});
    const scope = mockStackBelow(
      13,
      ["ciflow/inductor"],
      [[12, ["torch/_dynamo/a.py"], []]]
    );
    const result = await coverage(
      await prsOf([
        ciflowJob(1, 13, "ciflow/inductor/13"),
        ciflowJob(2, 14, "ciflow/periodic/14"),
        ciflowJob(3, 15, "gh/alice/15/head"),
        ciflowJob(4, 16, "ciflow/inductor/33"),
      ]),
      new Map(),
      false
    );
    scope.done();
    expect(pulls.isDone()).toBe(false);
    expect(result.walked).toEqual(new Set([13]));
    expect(result.coversBelow).toEqual(
      new Map([[13, new Map([["ciflow/inductor", [12]]])]])
    );
    expect(result.coveredBy).toEqual(
      new Map([[12, [{ cover: 13, label: "ciflow/inductor" }]]])
    );
  });

  test("the scheduled fan-out fetches, in one batch, the covered PRs of failing labels and the PRs that show a block of a PR in the run, not the covered PRs of a passing label, and walks the covers it adds", async () => {
    const workflowsByPR = await prsOf([
      ciflowJob(1, 13, "ciflow/mps/13"),
      ciflowJob(2, 13, "ciflow/inductor/13", { conclusion: "success" }),
    ]);
    const comments = new Map<number, { id: number; body: string }>();
    const job11 = ciflowJob(3, 11, "ciflow/inductor/11");
    const fetchSpy = mockFetchedPrs(
      [job11, ciflowJob(4, 12, "gh/alice/12/head", { conclusion: "success" })],
      {
        11: "comment of 11",
        10: aboveBlock(13, "ciflow/mps", 10, 1),
        8: aboveBlock(14, "ciflow/mps", 8, 1),
      }
    );
    // The query also returns an open PR that shares a requested PR's head.
    fetchSpy.mockResolvedValueOnce([job11, { ...job11, id: 5, pr_number: 98 }]);
    const scopes = [
      mockStackBelow(
        13,
        ["ciflow/inductor", "ciflow/mps"],
        [
          [12, ["torch/_dynamo/a.py"], []],
          [11, ["torch/mps/a.py"], ["ciflow/inductor"]],
        ]
      ),
      mockStackBelow(
        11,
        ["ciflow/inductor"],
        [[9, ["torch/_dynamo/b.py"], []]]
      ),
    ];
    const result = await coverage(workflowsByPR, comments, true);
    scopes.forEach((scope) => scope.done());
    expect(fetchSpy.mock.calls.map(([, prNumbers]) => prNumbers)).toEqual([
      [11, 10],
    ]);
    expect(Array.from(workflowsByPR.keys()).sort((a, b) => a - b)).toEqual([
      11, 13,
    ]);
    expect(comments.get(11)).toEqual({ id: 110, body: "comment of 11" });
    expect(result.walked).toEqual(new Set([13, 11]));
    expect(result.coveredBy.get(9)).toEqual([
      { cover: 11, label: "ciflow/inductor" },
    ]);
  });

  test("a single-PR run neither looks up nor fetches anything", async () => {
    const workflowsByPR = await prsOf([ciflowJob(1, 13, "ciflow/inductor/13")]);
    const fetchSpy = mockFetchedPrs([], {
      10: aboveBlock(13, "ciflow/inductor", 10, 1),
    });
    const scope = mockStackBelow(
      13,
      ["ciflow/inductor"],
      [[12, ["torch/_dynamo/a.py"], []]]
    );
    const result = await coverage(workflowsByPR, new Map(), false);
    scope.done();
    expect(clickhouse.queryClickhouse).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(Array.from(workflowsByPR.keys())).toEqual([13]);
    expect(result.coveredBy.get(12)).toEqual([
      { cover: 13, label: "ciflow/inductor" },
    ]);
  });

  test("a walk error, or the budget running out, marks the cover failed", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest
      .spyOn(botUtils, "getOpenStackPrs")
      .mockReturnValue(new Promise(() => {}));
    const sameRepo = { full_name: "pytorch/pytorch" };
    nock("https://api.github.com")
      .get("/repos/pytorch/pytorch/pulls/13")
      .reply(502, { message: "Server Error" })
      .get("/repos/pytorch/pytorch/pulls/14")
      .reply(200, {
        number: 14,
        body: "",
        labels: [{ name: "ciflow/inductor" }],
        head: { ref: "gh/alice/14/head", repo: sameRepo },
        base: { ref: "main", repo: sameRepo },
      });
    const result = await coverage(
      await prsOf([
        ciflowJob(1, 13, "ciflow/inductor/13"),
        ciflowJob(2, 14, "ciflow/inductor/14"),
      ]),
      new Map(),
      false,
      50
    );
    expect(result.failed).toEqual(new Set([13, 14]));
    expect(result.walked).toEqual(new Set());
    expect(console.error).toHaveBeenCalledWith(
      "could not read the stack below PR",
      14,
      "for ciflow coverage",
      expect.objectContaining({
        message: "the walk of PR 14 did not finish within 50 ms",
      })
    );
  });

  test("a failed or hanging lookup of the PRs that show a block is logged, and the covered PRs are still fetched", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    const workflowsByPR = await prsOf([ciflowJob(1, 13, "ciflow/inductor/13")]);
    const fetchSpy = mockFetchedPrs(
      [ciflowJob(2, 12, "gh/alice/12/head", { conclusion: "success" })],
      { 11: aboveBlock(13, "ciflow/inductor", 11, 1) }
    );
    const error = new Error("ClickHouse 500");
    (clickhouse.queryClickhouse as jest.Mock).mockRejectedValueOnce(error);
    const scope = mockStackBelow(
      13,
      ["ciflow/inductor"],
      [[12, ["torch/_dynamo/a.py"], []]]
    );
    const result = await coverage(workflowsByPR, new Map(), true);
    scope.done();
    expect(console.error).toHaveBeenCalledWith(
      "could not look up the PRs that show a ciflow run above in",
      "pytorch",
      "pytorch",
      error
    );
    expect(fetchSpy.mock.calls.map(([, prNumbers]) => prNumbers)).toEqual([
      [12],
    ]);
    expect(Array.from(workflowsByPR.keys())).toEqual([13, 12]);
    expect(result.walked).toEqual(new Set([13]));

    (clickhouse.queryClickhouse as jest.Mock).mockReturnValueOnce(
      new Promise(() => {})
    );
    const quiet = await prsOf([
      ciflowJob(3, 13, "ciflow/inductor/13", { conclusion: "success" }),
    ]);
    expect(await coverage(quiet, new Map(), true, 50)).toEqual(empty);
    expect(console.error).toHaveBeenLastCalledWith(
      "could not look up the PRs that show a ciflow run above in",
      "pytorch",
      "pytorch",
      expect.objectContaining({
        message:
          "looking up the PRs that show a run above did not finish within 50 ms",
      })
    );
  });

  test("a fan-out fetch past the budget adds no PR", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    const workflowsByPR = await prsOf([ciflowJob(1, 13, "ciflow/inductor/13")]);
    mockFetchedPrs([], {}).mockReturnValue(new Promise(() => {}));
    const scope = mockStackBelow(
      13,
      ["ciflow/inductor"],
      [[12, ["torch/_dynamo/a.py"], []]]
    );
    const result = await coverage(workflowsByPR, new Map(), true, 500);
    scope.done();
    expect(result.walked).toEqual(new Set([13]));
    expect(Array.from(workflowsByPR.keys())).toEqual([13]);
    expect(console.error).toHaveBeenCalledWith(
      "could not fetch PRs",
      [12],
      "for ciflow coverage",
      expect.objectContaining({
        message: "fetching the covered PRs did not finish within 500 ms",
      })
    );
  });
});

describe("addCoveredCiflowNotes", () => {
  function notes(
    jobs: RecentWorkflowsData[],
    coveredByLabel?: Map<string, number[]>
  ) {
    const relatedInfo = new Map<number, string>([[11, "earlier note"]]);
    updateDrciBot.addCoveredCiflowNotes(
      "pytorch",
      "pytorch",
      3,
      jobs,
      relatedInfo,
      coveredByLabel
    );
    return relatedInfo;
  }

  test("notes the covered PRs once per label, on the first failing job of the run", () => {
    const relatedInfo = notes(
      [
        ciflowJob(10, 3, "ciflow/inductor/3", { name: "b job" }),
        ciflowJob(11, 3, "ciflow/inductor/3", { name: "a job" }),
      ],
      new Map([["ciflow/inductor", [2]]])
    );
    expect(relatedInfo.get(11)).toEqual(
      `earlier note; ciflow/inductor on this PR also tests PR ${link(
        2
      )} below it, which needs it and does not run it itself; the failure may come from that PR, which then needs the fix`
    );
    expect(relatedInfo.has(10)).toBe(false);
  });

  test("caps the list of covered PRs", () => {
    const covered = Array.from({ length: 12 }, (_, i) => 100 - i);
    const relatedInfo = notes(
      [ciflowJob(10, 3, "ciflow/inductor/3")],
      new Map([["ciflow/inductor", covered]])
    );
    const note = relatedInfo.get(10)!;
    expect(note).toContain(`${link(100)}, ${link(99)}`);
    expect(note).toContain(`${link(91)} and 2 more below it`);
    expect(note).not.toContain(link(90));
    expect(note).not.toContain("#");
  });

  test("no note for other runs, or for labels the coverage does not list", () => {
    const relatedInfo = notes(
      [
        ciflowJob(10, 3, "gh/alice/3/head"),
        ciflowJob(12, 3, "ciflow/inductor/33"),
        ciflowJob(13, 3, "ciflow/mps/3"),
      ],
      new Map([["ciflow/inductor", [2]]])
    );
    expect(Array.from(relatedInfo.keys())).toEqual([11]);
    expect(
      Array.from(notes([ciflowJob(10, 3, "ciflow/inductor/3")]).keys())
    ).toEqual([11]);
  });
});

describe("renderFailuresAbove", () => {
  type CoverFailures = {
    cover: number;
    label: string;
    failures: RecentWorkflowsData[] | null;
  };
  const render = (
    covers: CoverFailures[],
    comment?: string,
    isUnresolved: (_cover: number) => boolean = () => false,
    lowerPr: { headSha?: string; labels?: string[] } = {}
  ) =>
    updateDrciBot.renderFailuresAbove(
      HUD_URL,
      "pytorch",
      "pytorch",
      { headSha: shaOf(12), labels: [], comment, ...lowerPr },
      covers,
      isUnresolved
    );
  const inductorJobs = (cover: number, count: number) =>
    Array.from({ length: count }, (_, i) =>
      ciflowJob(cover * 100 + i, cover, `ciflow/inductor/${cover}`, {
        name: `job ${String(i).padStart(2, "0")}`,
      })
    );

  test("a fresh section lists the cover's failed and cancelled jobs of the label's run between its markers", () => {
    const { sections, count } = render([
      {
        cover: 13,
        label: "ciflow/inductor",
        failures: [
          ciflowJob(21, 13, "ciflow/inductor/13", {
            name: "inductor b",
            conclusion: "cancelled",
          }),
          ciflowJob(20, 13, "ciflow/inductor/13", { name: "inductor a" }),
          ciflowJob(22, 13, "ciflow/mps/13", { name: "mps run" }),
          ciflowJob(23, 13, "gh/alice/13/head", { name: "pull run" }),
        ],
      },
    ]);
    expect(count).toBe(2);
    expect(sections).toContain(
      `\n<!-- drci-ciflow-above 13 ciflow/inductor ${shaOf(
        12
      )} 2 -->\n<details open><summary><b>FAILURES ABOVE</b> - This PR needs <code>ciflow/inductor</code> and does not run it. PR <a href="https://redirect.github.com/pytorch/pytorch/pull/13">13</a> above runs it, and that run also tests this PR. The following jobs did not pass there; the cause may be in this PR, in PR 13 or in a PR between them:</summary>`
    );
    expect(sections.indexOf("<!-- drci-ciflow-above")).toBe(1);
    expect(sections).toContain(
      `* [inductor a](${HUD_URL}/pr/pytorch/pytorch/13#20) ([gh](abcdefg))\n`
    );
    expect(sections).toContain(
      `[inductor b](${HUD_URL}/pr/pytorch/pytorch/13#21)`
    );
    expect(sections.endsWith(`</p></details>\n${ABOVE_END}`)).toBe(true);
    for (const text of ["mps run", "pull run", "#13"]) {
      expect(sections).not.toContain(text);
    }

    const capped = render([
      { cover: 13, label: "ciflow/inductor", failures: inductorJobs(13, 12) },
    ]);
    expect(capped.count).toBe(12);
    expect(capped.sections).toContain(`${shaOf(12)} 12 -->`);
    expect(capped.sections).toContain(
      "The following 10 of 12 jobs did not pass there"
    );
    expect(capped.sections).toContain("[job 09]");
    expect(capped.sections).not.toContain("[job 10]");

    const odd = "ciflow/a b";
    expect(
      render([
        { cover: 13, label: odd, failures: [ciflowJob(1, 13, `${odd}/13`)] },
      ])
    ).toEqual({ sections: "", count: 0 });
  });

  test("a section is carried over while this run could not look its cover up", () => {
    const block = aboveBlock(13, "ciflow/inductor", 12, 2);
    const comment = `old comment\n${block}\n<details >...`;
    const carried = { sections: `\n${block}`, count: 2 };
    expect(render([], comment, (cover) => cover === 13)).toEqual(carried);
    expect(
      render([{ cover: 13, label: "ciflow/inductor", failures: null }], comment)
    ).toEqual(carried);
  });

  test("a section is dropped when its cover resolves without it, on a new head, or once this PR carries the label", () => {
    const comment = `old comment\n${aboveBlock(
      13,
      "ciflow/inductor",
      12,
      2
    )}\n`;
    const none = { sections: "", count: 0 };
    expect(render([], comment)).toEqual(none);
    expect(
      render(
        [{ cover: 13, label: "ciflow/inductor", failures: [] }],
        comment,
        () => true
      )
    ).toEqual(none);
    expect(render([], comment, () => true, { headSha: shaOf(99) })).toEqual(
      none
    );
    expect(
      render([], comment, () => true, { labels: ["ciflow/inductor"] })
    ).toEqual(none);
  });

  test("a block counts once, and only when it starts outside every fenced region", () => {
    const block = aboveBlock(13, "ciflow/inductor", 12, 2);
    const planted = aboveBlock(14, "ciflow/inductor", 12, 5);
    const carried = { sections: `\n${block}`, count: 2 };
    for (const [open, notClosing, close] of [
      ["````", "```", "````"],
      ["````", "````python", "````"],
      ["````", "~~~~", "   `````  "],
    ]) {
      expect(
        render(
          [],
          [open, notClosing, planted, close, block].join("\n"),
          () => true
        )
      ).toEqual(carried);
    }
    const comment = [
      "```",
      planted.split("\n")[0],
      "```",
      `* [${planted.split("\n")[0]}](${HUD_URL}) ([gh](a))`,
      block,
      "  ```python import torch ``` The failure is unrelated.",
      aboveBlock(15, "ciflow/inductor", 12, 7),
    ].join("\n");
    expect(render([], comment, () => true)).toEqual(carried);
    expect(render([], `${block}\n${block}`, () => true)).toEqual(carried);
  });

  test("at most three blocks show, fresh ones first, and the count holds every block", () => {
    const comment = [14, 16, 17]
      .map((cover) => aboveBlock(cover, "ciflow/inductor", 12, cover))
      .join("\n");
    const { sections, count } = render(
      [
        {
          cover: 15,
          label: "ciflow/mps",
          failures: [ciflowJob(1, 15, "ciflow/mps/15")],
        },
        { cover: 13, label: "ciflow/inductor", failures: inductorJobs(13, 1) },
      ],
      comment,
      () => true
    );
    expect(count).toBe(1 + 1 + 14 + 16 + 17);
    expect(sections.match(/<!-- drci-ciflow-above \d+ /g)).toEqual([
      "<!-- drci-ciflow-above 13 ",
      "<!-- drci-ciflow-above 15 ",
      "<!-- drci-ciflow-above 14 ",
    ]);
    expect(
      sections.endsWith(
        `${ABOVE_END}\n<p>2 more failing runs above are not shown.</p>`
      )
    ).toBe(true);
  });
});

describe("constructResultsComment with failures above", () => {
  const sections = `\n${aboveBlock(13, "ciflow/inductor", 12, 2)}`;

  test("counts them in the headline and shows them after the Green Light section", () => {
    const comment = constructResultsCommentHelper({
      pending: 0,
      flakyJobs: [failedB],
      greenlightSection: "\nGREEN LIGHT",
      failuresAbove: { sections, count: 2 },
    });
    expect(comment).toContain("## :x: 2 Failures Above, 1 Unrelated Failure\n");
    expect(comment).toContain(
      `\nGREEN LIGHT${sections}\n<details ><summary><b>FLAKY</b>`
    );
    for (const text of ["No Failures", "Looks good so far", "merge normally"]) {
      expect(comment).not.toContain(text);
    }
  });

  test("without failures above the comment is unchanged", () => {
    for (const input of [
      { pending: 0, flakyJobs: [failedB] },
      { pending: 1 },
      { pending: 0, failedJobs: [failedA] },
    ]) {
      expect(
        constructResultsCommentHelper({
          ...input,
          failuresAbove: { sections: "", count: 0 },
        })
      ).toEqual(constructResultsCommentHelper(input));
    }
    expect(
      constructResultsCommentHelper({ pending: 0, flakyJobs: [failedB] })
    ).toContain(
      "## :white_check_mark: You can merge normally! (1 Unrelated Failure)"
    );
  });
});

describe("updateDrciComments with a failing ciflow run above", () => {
  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  // Fakes what a run reads outside GitHub: ClickHouse has the jobs (recentPrs'
  // as recent ones), the Dr.CI comments and the merge bases. Records the
  // comment written for each rendered PR.
  function mockRun(
    jobs: RecentWorkflowsData[],
    comments: { [pr: number]: string },
    recentPrs: number[]
  ) {
    const fetchSpy = mockFetchedPrs(jobs, comments, recentPrs);
    jest
      .spyOn(clickhouse, "queryClickhouseSaved")
      .mockImplementation(async (name, params: any) =>
        name === "merge_bases"
          ? params.shas.map((sha: string) => ({
              head_sha: sha,
              merge_base: "base",
              merge_base_commit_date: "2026-10-29 09:00:00",
            }))
          : []
      );
    jest.spyOn(botUtils, "fetchJSON").mockResolvedValue([]);
    jest
      .spyOn(crcrAllowlist, "fetchCrcrAllowlist")
      .mockResolvedValue(CrcrAllowlist.fromYaml("{}"));
    jest
      .spyOn(greenlightComment, "buildGreenlightSections")
      .mockResolvedValue(new Map());
    jest.spyOn(drciUtils, "hasSimilarFailures").mockResolvedValue(undefined);
    jest.spyOn(jobUtils, "hasS3Log").mockResolvedValue(true);
    jest
      .spyOn(labelerConfigUtils, "loadLabelerConfig")
      .mockResolvedValue(ciflowLabelerConfig);
    const bodies: { [commentId: number]: string } = {};
    nock("https://api.github.com")
      .persist()
      .patch((uri) => uri.startsWith("/repos/pytorch/pytorch/issues/comments/"))
      .reply(200, (uri, body: any) => {
        bodies[parseInt(uri.split("/").pop()!)] = body.body;
        return {};
      })
      .post("/repos/pytorch/pytorch/check-runs")
      .reply(200, {});
    return { bodies, fetchSpy };
  }

  const run = (prNumbers: number[]) =>
    updateDrciBot.updateDrciComments(
      utils.testOctokit(),
      "pytorch",
      "pytorch",
      prNumbers
    );
  // PR 13's ciflow/inductor run: a real failure and an infra-flaky one.
  const runOf13 = (conclusion: string) => [
    ciflowJob(1, 13, "ciflow/inductor/13", {
      name: "inductor test",
      conclusion,
      failure_captures: ["AssertionError"],
    }),
    ciflowJob(2, 13, "ciflow/inductor/13", {
      name: "inductor infra",
      conclusion,
      failure_lines: [],
      runnerName: "",
    }),
  ];
  const job12 = ciflowJob(3, 12, "gh/alice/12/head", { conclusion: "success" });
  const stackOf13 = () =>
    mockStackBelow(13, ["ciflow/inductor"], [[12, ["torch/_dynamo/a.py"], []]]);
  const block13 = aboveBlock(13, "ciflow/inductor", 12, 1);

  test("a scheduled run shows the failing run above on the lower PR and notes the lower PR on the cover", async () => {
    const { bodies, fetchSpy } = mockRun(
      [...runOf13("failure"), job12],
      { 12: "old comment of 12", 13: "old comment of 13" },
      [13]
    );
    const scope = stackOf13();
    const failures = await run([]);
    scope.done();
    expect(Object.keys(failures)).toEqual(["12", "13"]);
    expect(fetchSpy).toHaveBeenCalledWith("pytorch/pytorch", [12], "30");
    expect(failures[12].FAILED).toEqual([]);
    expect(bodies[120]).toContain("## :x: 1 Failure Above\n");
    expect(bodies[120]).toContain(
      `\n<!-- drci-ciflow-above 13 ciflow/inductor ${shaOf(
        12
      )} 1 -->\n<details open><summary><b>FAILURE ABOVE</b>`
    );
    expect(bodies[120]).toContain(
      `[inductor test](${HUD_URL}/pr/pytorch/pytorch/13#1)`
    );
    expect(bodies[120]).not.toContain("inductor infra");
    expect(bodies[130]).toContain(`also tests PR ${link(12)} below it`);
    expect(bodies[130]).not.toContain("<!-- drci-ciflow");
  });

  test("a single-PR run on the cover does not add the covered PRs", async () => {
    const { bodies } = mockRun(
      [...runOf13("failure"), job12],
      { 12: "old comment of 12", 13: "old comment of 13" },
      []
    );
    const scope = stackOf13();
    const failures = await run([13]);
    scope.done();
    expect(Object.keys(failures)).toEqual(["13"]);
    expect(bodies[130]).toContain(`also tests PR ${link(12)} below it`);
  });

  test("a single-PR run on the lower PR keeps its section", async () => {
    const { bodies } = mockRun(
      [...runOf13("failure"), job12],
      { 12: `old comment of 12\n${block13}\n`, 13: "old comment of 13" },
      []
    );
    const failures = await run([12]);
    expect(Object.keys(failures)).toEqual(["12"]);
    expect(Object.keys(bodies)).toEqual(["120"]);
    expect(bodies[120]).toContain("## :x: 1 Failure Above\n");
    expect(bodies[120]).toContain(`\n${block13}\n`);
  });

  test("a lower PR whose comment ClickHouse lacks keeps its section, read from GitHub", async () => {
    const { bodies } = mockRun([job12], {}, []);
    nock("https://api.github.com")
      .get("/repos/pytorch/pytorch/issues/12/comments")
      .reply(200, [
        {
          id: 120,
          user: { login: "pytorch-bot[bot]" },
          body: `${DRCI_COMMENT_START}old comment of 12\n${block13}\n`,
        },
      ]);
    await run([12]);
    expect(bodies[120]).toContain("## :x: 1 Failure Above\n");
    expect(bodies[120]).toContain(`\n${block13}\n`);
  });

  // 13 was pushed alone: its new ciflow/inductor run passed and the webhook
  // rebuilt its comment, while 12 kept its head and its section.
  test("after a fix on the cover, a scheduled run with the cover finds the lower PR by its section and clears it", async () => {
    const { bodies, fetchSpy } = mockRun(
      [...runOf13("success"), job12],
      { 12: `old comment of 12\n${block13}\n`, 13: "rebuilt comment of 13" },
      [13]
    );
    const failures = await run([]);
    expect(Object.keys(failures)).toEqual(["12", "13"]);
    expect(fetchSpy).toHaveBeenCalledWith("pytorch/pytorch", [12], "30");
    expect(bodies[120]).toContain("## :white_check_mark: No Failures\n");
    expect(bodies[120]).not.toContain("drci-ciflow-above");
  });

  test("a lower PR whose comment write failed is found again by the next scheduled run", async () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    const failedWrite = nock("https://api.github.com")
      .patch("/repos/pytorch/pytorch/issues/comments/120")
      .reply(422, { message: "Validation Failed" });
    const { bodies } = mockRun(
      [...runOf13("success"), job12],
      { 12: `old comment of 12\n${block13}\n`, 13: "rebuilt comment of 13" },
      [13]
    );
    await run([]);
    failedWrite.done();
    expect(bodies[120]).toBeUndefined();
    await run([]);
    expect(bodies[120]).toContain("## :white_check_mark: No Failures\n");
    expect(bodies[120]).not.toContain("drci-ciflow-above");
  });

  test("when the walk of the cover fails, the lower PR keeps its section", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    const { bodies } = mockRun(
      [...runOf13("failure"), job12],
      { 12: `old comment of 12\n${block13}\n`, 13: "old comment of 13" },
      [12, 13]
    );
    nock("https://api.github.com")
      .get("/repos/pytorch/pytorch/pulls/13")
      .reply(502, { message: "Server Error" });
    const failures = await run([]);
    expect(Object.keys(failures)).toEqual(["12", "13"]);
    expect(bodies[120]).toContain("## :x: 1 Failure Above\n");
    expect(bodies[120]).toContain(`\n${block13}\n`);
    expect(bodies[130]).not.toContain("also tests PR");
  });

  test("when the classification of the cover throws, the lower PR keeps its section", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
    const { bodies } = mockRun(
      [...runOf13("failure"), job12],
      { 12: `old comment of 12\n${block13}\n`, 13: "old comment of 13" },
      [12, 13]
    );
    const error = new Error("ClickHouse 500");
    jest
      .spyOn(drciUtils, "fetchPRLabels")
      .mockImplementation(async (_owner, _repo, prNumber) => {
        if (prNumber === 13) {
          throw error;
        }
        return [];
      });
    const scope = stackOf13();
    const failures = await run([]);
    scope.done();
    expect(Object.keys(failures)).toEqual(["12"]);
    expect(bodies[120]).toContain(`\n${block13}\n`);
    expect(console.error).toHaveBeenCalledWith(
      "classification of PR",
      13,
      "above PR",
      12,
      "threw",
      error
    );
  });

  test("when the coverage step throws, the lower PR keeps its section", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    const { bodies } = mockRun(
      [...runOf13("failure"), job12],
      { 12: `old comment of 12\n${block13}\n`, 13: "old comment of 13" },
      [12, 13]
    );
    // Not a config: the step then throws outside its own error handling.
    (labelerConfigUtils.loadLabelerConfig as jest.Mock).mockResolvedValue(
      undefined
    );
    await run([]);
    expect(bodies[120]).toContain(`\n${block13}\n`);
    expect(console.error).toHaveBeenCalledWith(
      "ciflow coverage threw for",
      "pytorch",
      "pytorch",
      expect.any(TypeError)
    );
  });

  test("when the labeler config cannot be read, the lower PR keeps its section; without one, the section goes", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    const jobs = [
      ...runOf13("failure"),
      job12,
      ciflowJob(4, 14, "ciflow/inductor/14"),
    ];
    const comments = {
      12: `old comment of 12\n${block13}\n`,
      13: "old comment of 13",
    };
    let { bodies } = mockRun(jobs, comments, [12, 13]);
    (labelerConfigUtils.loadLabelerConfig as jest.Mock).mockRejectedValue(
      new Error("GitHub 502")
    );
    await run([]);
    expect(bodies[120]).toContain(`\n${block13}\n`);

    nock.cleanAll();
    ({ bodies } = mockRun(jobs, comments, [12, 14]));
    (labelerConfigUtils.loadLabelerConfig as jest.Mock).mockResolvedValue(null);
    await run([]);
    expect(bodies[120]).not.toContain("drci-ciflow-above");
  });
});
