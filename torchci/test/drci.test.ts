import nock from "nock";
import * as updateDrciBot from "../pages/api/drci/drci";
import {
  OH_URL,
  DOCS_URL,
  DRCI_COMMENT_START,
  formDrciComment,
  formDrciHeader,
  getActiveSEVs,
  formDrciSevBody,
  isInfraFlakyJob,
} from "lib/drciUtils";
import { IssueData, RecentWorkflowsData } from "lib/types";
import dayjs from "dayjs";
import { removeJobNameSuffix } from "lib/jobUtils";
import * as fetchRecentWorkflows from "lib/fetchRecentWorkflows";
import * as drciUtils from "lib/drciUtils";

nock.disableNetConnect();

export const successfulA = {
  name: "linux-docs / build-docs (cpp)",
  conclusion: "success",
  completed_at: "2022-07-13T19:34:03Z",
  html_url: "abcdefg",
  head_sha: "abcdefg",
  pr_number: 1000,
  id: "1",
  failure_captures: ["a"],
};

const pendingA = {
  name: "linux-docs / build-docs (cpp)",
  conclusion: undefined,
  completed_at: null,
  html_url: "abcdefg",
  head_sha: "abcdefg",
  id: "1",
  pr_number: 1001,
  failure_captures: ["a"],
  runnerName: "dummy",
};

const failedA = {
  name: "Lint",
  conclusion: "failure",
  completed_at: "2022-07-13T19:34:03Z",
  html_url: "a",
  head_sha: "abcdefg",
  id: "1",
  pr_number: 1001,
  failure_captures: ["a"],
  runnerName: "dummy",
};

const failedASuccessfulRetry = {
  name: "Lint",
  conclusion: "success",
  completed_at: "2022-07-14T19:34:03Z",
  html_url: "a",
  head_sha: "abcdefg",
  id: "2",
  pr_number: 1001,
  failure_captures: ["a"],
  runnerName: "dummy",
};

const failedAFailedRetry = {
  name: "Lint",
  conclusion: "failure",
  completed_at: "2022-07-15T19:34:03Z",
  html_url: "a",
  head_sha: "abcdefg",
  id: "3",
  pr_number: 1001,
  failure_captures: ["a"],
  runnerName: "dummy",
};

const failedB = {
  name: "something",
  conclusion: "failure",
  completed_at: "2022-07-13T19:34:03Z",
  html_url: "a",
  head_sha: "abcdefg",
  id: "1",
  pr_number: 1001,
  failure_captures: ["a"],
  runnerName: "dummy",
};

const failedC = {
  name: "z-docs / build-docs (cpp)",
  conclusion: "failure",
  completed_at: "2022-07-13T19:34:03Z",
  html_url: "a",
  head_sha: "abcdefg",
  id: "1",
  pr_number: 1001,
  failure_captures: ["a"],
  runnerName: "dummy",
};

const failedD = {
  name: "linux-bionic-cuda12.1-py3.10-gcc9-sm86 / test (default, 1, 5, linux.g5.4xlarge.nvidia.gpu)",
  conclusion: "failure",
  completed_at: "2022-07-13T19:34:03Z",
  html_url: "a",
  head_sha: "abcdefg",
  id: "1",
  pr_number: 1001,
  failure_captures: ["a", "b"],
  runnerName: "dummy",
};

// Same as failedD but has a different shard ID
const failedE = {
  name: "linux-bionic-cuda12.1-py3.10-gcc9-sm86 / test (default, 3, 5, linux.g5.4xlarge.nvidia.gpu)",
  conclusion: "failure",
  completed_at: "2022-07-13T19:34:03Z",
  html_url: "a",
  head_sha: "abcdefg",
  id: "1",
  pr_number: 1001,
  failure_captures: ["a", "b"],
  runnerName: "dummy",
};

// Same as unstable A but without the unstable suffix
const failedF = {
  name: "win-vs2019-cpu-py3 / test (default, 2, 3, windows.4xlarge)",
  conclusion: "failure",
  completed_at: "2022-07-13T19:34:03Z",
  html_url: "a",
  head_sha: "abcdefg",
  id: "1",
  pr_number: 1001,
  failure_captures: ["a", "b"],
  runnerName: "dummy",
};

// Some additional mock samples for flaky rules regex match
const failedG = {
  name: "win-vs2019-cpu-py3 / build",
  conclusion: "failure",
  completed_at: "2022-07-13T19:34:03Z",
  html_url: "a",
  head_sha: "abcdefg",
  id: "1",
  pr_number: 1001,
  failure_captures: [
    "The process cannot access the file 'C:\\actions-runner\\_work\\_actions\\mock' because it is being used by another process.",
  ],
  runnerName: "dummy",
};

const failedH = {
  name: "cuda12.1-py3.10-gcc9-sm86-periodic-dynamo-benchmarks / test (dynamo_eager_huggingface, 1, 1, linux.g5.4xlarge.nvidia.gpu)",
  conclusion: "failure",
  completed_at: "2022-07-13T19:34:03Z",
  html_url: "a",
  head_sha: "abcdefg",
  id: "1",
  pr_number: 1001,
  failure_captures: [
    "##[error]The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.",
  ],
  runnerName: "dummy",
};

// Match with failure line string instead of failure capture array
const failedI = {
  name: "macos-12-py3-arm64 / test (default, 2, 3, macos-m1-12)",
  conclusion: "failure",
  completed_at: "2022-07-13T19:34:03Z",
  html_url: "a",
  head_sha: "abcdefg",
  id: "1",
  pr_number: 1001,
  failure_captures: [],
  failure_line:
    "RuntimeError: inductor/test_torchinductor_opinfo 2/2 failed! Received signal: SIGSEGV",
  runnerName: "dummy",
};

const unstableA = {
  name: "win-vs2019-cpu-py3 / test (default, 1, 3, windows.4xlarge, unstable)",
  conclusion: "failure",
  completed_at: "2022-07-13T19:34:03Z",
  html_url: "a",
  head_sha: "abcdefg",
  id: "1",
  pr_number: 1001,
  failure_captures: ["a", "b"],
  runnerName: "dummy",
};

const sev: IssueData = {
  number: 85362,
  title: "docker pulls failing with no space left on disk",
  html_url: "https://github.com/pytorch/pytorch/issues/85362",
  state: "open",
  body: "random stuff",
  updated_at: dayjs().toString(),
  author_association: "MEMBER",
};

const mergeBlockingSev: IssueData = {
  number: 74967,
  title: "Linux CUDA builds are failing due to missing deps",
  html_url: "https://github.com/pytorch/pytorch/issues/74967",
  state: "open",
  body: "merge blocking",
  updated_at: dayjs().toString(),
  author_association: "MEMBER",
};

const closedSev: IssueData = {
  number: 74304,
  title: "GitHub Outage: No Github Actions workflows can be run",
  html_url: "https://github.com/pytorch/pytorch/issues/74304",
  state: "closed",
  body: "random stuff",
  updated_at: dayjs().toString(),
  author_association: "MEMBER",
};

function constructResultsCommentHelper({
  pending = 3,
  failedJobs = [],
  flakyJobs = [],
  brokenTrunkJobs = [],
  unstableJobs = [],
  sha = "random sha",
  merge_base = "random_merge_base_sha",
  merge_base_date = "2023-08-08T06:03:21Z",
  hud_pr_url = "random hud pr url",
}: {
  pending?: number;
  failedJobs?: RecentWorkflowsData[];
  flakyJobs?: RecentWorkflowsData[];
  brokenTrunkJobs?: RecentWorkflowsData[];
  unstableJobs?: RecentWorkflowsData[];
  sha?: string;
  merge_base?: string;
  merge_base_date?: string;
  hud_pr_url?: string;
}) {
  return updateDrciBot.constructResultsComment(
    pending,
    failedJobs,
    flakyJobs,
    brokenTrunkJobs,
    unstableJobs,
    sha,
    merge_base,
    merge_base_date,
    hud_pr_url
  );
}

describe("Update Dr. CI Bot Unit Tests", () => {
  beforeEach(() => {
    const mock = jest.spyOn(drciUtils, "hasSimilarFailures");
    mock.mockImplementation(() => Promise.resolve(false));
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
      hud_pr_url: "hudlink",
    });
    const failedJobName = failedA.name;

    expect(failureInfo.includes("3 New Failures, 1 Pending")).toBeTruthy();
    expect(failureInfo.includes(failedJobName)).toBeTruthy();
    const expectedFailureOrder = `* [Lint](hudlink#1) ([gh](a))
* [something](hudlink#1) ([gh](a))
* [z-docs / build-docs (cpp)](hudlink#1) ([gh](a))`;
    expect(failureInfo.includes(expectedFailureOrder)).toBeTruthy();
  });

  test("Check that reorganizeWorkflows works correctly", async () => {
    const originalWorkflows = [successfulA, pendingA, failedA];
    const workflowsByPR = await updateDrciBot.reorganizeWorkflows(
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
    const comment = formDrciComment(successfulA.pr_number);
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
    const originalWorkflows = [failedA, failedB, unstableA];
    const workflowsByPR = await updateDrciBot.reorganizeWorkflows(
      originalWorkflows
    );
    const pr_1001 = workflowsByPR.get(1001)!;
    const { failedJobs, brokenTrunkJobs, flakyJobs, unstableJobs } =
      await updateDrciBot.getWorkflowJobsStatuses(
        pr_1001,
        [{ name: failedB.name, captures: failedB.failure_captures }],
        new Map().set(failedA.name, [failedA])
      );
    expect(failedJobs.length).toBe(0);
    expect(brokenTrunkJobs.length).toBe(1);
    expect(flakyJobs.length).toBe(1);
    expect(unstableJobs.length).toBe(1);
  });

  test(" test flaky rule regex", async () => {
    const originalWorkflows = [failedA, failedG, failedH, failedI];
    const workflowsByPR = await updateDrciBot.reorganizeWorkflows(
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
    expect(failedJobs.length).toBe(1);
    expect(brokenTrunkJobs.length).toBe(0);
    expect(flakyJobs.length).toBe(3);
    expect(unstableJobs.length).toBe(0);
  });

  test("test shard id and suffix in job name are handled correctly", async () => {
    const originalWorkflows = [failedA, failedD, failedF];
    const workflowsByPR = await updateDrciBot.reorganizeWorkflows(
      originalWorkflows
    );
    const pr_1001 = workflowsByPR.get(1001)!;

    const baseJobs = new Map();
    baseJobs.set(removeJobNameSuffix(failedD.name), [failedE]);
    baseJobs.set(removeJobNameSuffix(failedF.name), [unstableA]);

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
      "The following job failed but was likely due to flakiness present on trunk and has been marked as unstable",
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
      expectToContain.every((s) => failureInfoComment.includes(s))
    ).toBeTruthy();
  });

  test("test merge base time shows up in results comment", async () => {
    const failureInfoComment = constructResultsCommentHelper({
      sha: "sha",
      merge_base: "merge_base",
      merge_base_date: "2023-08-08T06:03:21Z",
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
    mock.mockImplementation(() => Promise.resolve(true));

    const originalWorkflows = [failedA, failedB];
    const workflowsByPR = await updateDrciBot.reorganizeWorkflows(
      originalWorkflows
    );
    const pr_1001 = workflowsByPR.get(1001)!;
    const { failedJobs, brokenTrunkJobs, flakyJobs, unstableJobs } =
      await updateDrciBot.getWorkflowJobsStatuses(pr_1001, [], new Map());
    expect(failedJobs.length).toBe(0);
    expect(brokenTrunkJobs.length).toBe(0);
    expect(flakyJobs.length).toBe(2);
    expect(unstableJobs.length).toBe(0);
  });

  //test("test isInfraFlakyJob", async () => {
  //});
});
