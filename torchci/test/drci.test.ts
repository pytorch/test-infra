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
} from "lib/drciUtils";
import { IssueData } from "lib/types";
import { testOctokit } from "./utils";
import dayjs from "dayjs";

nock.disableNetConnect();

const dummyBaseSha = "dummyBaseSha";
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
  conclusion: null,
  completed_at: null,
  html_url: "abcdefg",
  head_sha: "abcdefg",
  id: "1",
  pr_number: 1001,
  failure_captures: ["a"],
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

describe("Update Dr. CI Bot Unit Tests", () => {
  beforeEach(() => {});

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
    const { pending, failedJobs } = updateDrciBot.getWorkflowJobsStatuses(
      pr_1001,
      [],
      new Map()
    );
    const failureInfo = updateDrciBot.constructResultsComment(
      pending,
      failedJobs,
      [],
      [],
      [],
      pr_1001.head_sha,
      "random sha",
      "hudlink"
    );
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
    expect(pr_1000.jobs.size).toBe(1);
    expect(pr_1001.jobs.size).toBe(2);
  });

  test("Check that getWorkflowJobsStatuses works correctly", async () => {
    const originalWorkflows = [successfulA, pendingA, failedA];
    const workflowsByPR = await updateDrciBot.reorganizeWorkflows(
      originalWorkflows
    );
    const pr_1001 = workflowsByPR.get(1001)!;
    const { pending, failedJobs } = updateDrciBot.getWorkflowJobsStatuses(
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
    const { pending, failedJobs } = updateDrciBot.getWorkflowJobsStatuses(
      pr_1001,
      [],
      new Map()
    );

    const failureInfo = updateDrciBot.constructResultsComment(
      pending,
      failedJobs,
      [],
      [],
      [],
      pr_1001.head_sha,
      "random sha",
      "hudlink"
    );
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
    const { pending, failedJobs } = updateDrciBot.getWorkflowJobsStatuses(
      pr_1001,
      [],
      new Map()
    );

    const failureInfo = updateDrciBot.constructResultsComment(
      pending,
      failedJobs,
      [],
      [],
      [],
      pr_1001.head_sha,
      "random sha",
      "hudlink"
    );
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
    const { pending, failedJobs } = updateDrciBot.getWorkflowJobsStatuses(
      pr_1001,
      [],
      new Map()
    );
    const failureInfo = updateDrciBot.constructResultsComment(
      pending,
      failedJobs,
      [],
      [],
      [],
      pr_1001.head_sha,
      "random sha",
      "hudlink"
    );
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
    const { pending, failedJobs } = updateDrciBot.getWorkflowJobsStatuses(
      pr_1001,
      [],
      new Map()
    );
    const failureInfo = updateDrciBot.constructResultsComment(
      pending,
      failedJobs,
      [],
      [],
      [],
      pr_1001.head_sha,
      "random sha",
      "hudlink"
    );
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
      updateDrciBot.getWorkflowJobsStatuses(
        pr_1001,
        [{ name: failedB.name, captures: failedB.failure_captures }],
        new Map().set(failedA.name, [failedA])
      );
    expect(failedJobs.length).toBe(0);
    expect(brokenTrunkJobs.length).toBe(1);
    expect(flakyJobs.length).toBe(1);
    expect(unstableJobs.length).toBe(1);
  });

  test("test flaky, broken trunk, and unstable jobs are included in the comment", async () => {
    const failureInfoComment = updateDrciBot.constructResultsComment(
      1,
      [failedA],
      [failedB],
      [failedC],
      [unstableA],
      "random head sha",
      "random base sha",
      "hudlink"
    );
    const expectToContain = [
      "1 New Failure, 1 Pending, 3 Unrelated Failures",
      "The following job has failed",
      "The following job failed but was likely due to flakiness present on trunk",
      "The following job failed but was present on the merge base random base sha",
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
    const failureInfoComment = updateDrciBot.constructResultsComment(
      1,
      [],
      [failedB],
      [failedC],
      [unstableA],
      "random head sha",
      "random base sha",
      "hudlink"
    );

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
});
