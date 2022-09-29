import nock from "nock";
import * as updateDrciBot from "../pages/api/drci/drci";
import { OH_URL, DOCS_URL, DRCI_COMMENT_START, formDrciComment, getActiveSEVs } from "lib/drciUtils";
import { IssueData } from "lib/types";

nock.disableNetConnect();

const recentWorkflowA = {
    job_name: 'linux-docs / build-docs (cpp)',
    conclusion: "success",
    completed_at: '2022-07-13T19:34:03Z',
    html_url: "abcdefg",
    head_sha: "abcdefg",
    pr_number: 1000,
    owner_login: "swang392",
}

const recentWorkflowB = {
    job_name: 'linux-docs / build-docs (cpp)',
    conclusion: null,
    completed_at: null,
    html_url: "abcdefg",
    head_sha: "abcdefg",
    pr_number: 1001,
    owner_login: "notswang392",
}

const recentWorkflowC = {
    job_name: 'Lint',
    conclusion: "failure",
    completed_at: '2022-07-13T19:34:03Z',
    html_url: "a",
    head_sha: "abcdefg",
    pr_number: 1001,
    owner_login: "notswang392",
}

const recentWorkflowD = {
    job_name: 'something',
    conclusion: "failure",
    completed_at: '2022-07-13T19:34:03Z',
    html_url: "a",
    head_sha: "abcdefg",
    pr_number: 1001,
    owner_login: "notswang392",
}

const recentWorkflowE = {
    job_name: 'z-docs / build-docs (cpp)',
    conclusion: "failure",
    completed_at: '2022-07-13T19:34:03Z',
    html_url: "a",
    head_sha: "abcdefg",
    pr_number: 1001,
    owner_login: "notswang392",
}

const sev : IssueData= {
  number: 85362,
  title: "docker pulls failing with no space left on disk",
  html_url: "https://github.com/pytorch/pytorch/issues/85362",
  state: "open",
  body: "random stuff"
};

const mergeBlockingSev : IssueData= {
  number: 74967,
  title: "Linux CUDA builds are failing due to missing deps",
  html_url: "https://github.com/pytorch/pytorch/issues/74967",
  state: "open",
  body: "merge blocking"
};

const closedSev : IssueData= {
  number: 74304,
  title: "GitHub Outage: No Github Actions workflows can be run",
  html_url: "https://github.com/pytorch/pytorch/issues/74304",
  state: "closed",
  body: "random stuff"
};

describe("Update Dr. CI Bot Unit Tests", () => {
    beforeEach(() => { });

    afterEach(() => {
        nock.cleanAll();
        jest.restoreAllMocks();
    });

    test("Check that constructFailureAnalysis works correctly", async () => {
        const originalWorkflows = [recentWorkflowA, recentWorkflowB, recentWorkflowD, recentWorkflowC, recentWorkflowE];
        const workflowsByPR = updateDrciBot.reorganizeWorkflows(originalWorkflows);
        const pr_1001 = workflowsByPR.get(1001)!;
        const { pending, failedJobs } = updateDrciBot.getWorkflowJobsStatuses(pr_1001);
        const failureInfo = updateDrciBot.constructResultsComment(pending, failedJobs, pr_1001.head_sha);
        const failedJobName = recentWorkflowC.job_name;

        expect(failureInfo.includes("3 Failures, 1 Pending")).toBeTruthy();
        expect(failureInfo.includes(failedJobName)).toBeTruthy();
        const expectedFailureOrder = `* [Lint](a)
* [something](a)
* [z-docs / build-docs (cpp)](a)`;
        expect(failureInfo.includes(expectedFailureOrder)).toBeTruthy();
        console.log(failureInfo);
    });

    test("Check that reorganizeWorkflows works correctly", async () => {
        const originalWorkflows = [recentWorkflowA, recentWorkflowB, recentWorkflowC];
        const workflowsByPR = updateDrciBot.reorganizeWorkflows(originalWorkflows);
        const pr_1001 = workflowsByPR.get(1001)!;
        const pr_1000 = workflowsByPR.get(1000)!;

        expect(workflowsByPR.size).toBe(2);
        expect(pr_1000.jobs.length).toBe(1);
        expect(pr_1001.jobs.length).toBe(2);
    });

    test("Check that getWorkflowAnalysis works correctly", async () => {
        const originalWorkflows = [recentWorkflowA, recentWorkflowB, recentWorkflowC];
        const workflowsByPR = updateDrciBot.reorganizeWorkflows(originalWorkflows);
        const pr_1001 = workflowsByPR.get(1001)!;
        const { pending, failedJobs } = updateDrciBot.getWorkflowJobsStatuses(pr_1001);

        expect(pending).toBe(1);
        expect(failedJobs.length).toBe(1);
    });

    test("Check that dr ci comment is correctly formed", async () => {
        const comment = formDrciComment(recentWorkflowA.pr_number);
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
      const originalWorkflows = [
        recentWorkflowA,
        recentWorkflowB,
        recentWorkflowC,
      ];
      const workflowsByPR =
        updateDrciBot.reorganizeWorkflows(originalWorkflows);
      const pr_1001 = workflowsByPR.get(1001)!;
      const { pending, failedJobs } =
        updateDrciBot.getWorkflowJobsStatuses(pr_1001);

      const failureInfo = updateDrciBot.constructResultsComment(
        pending,
        failedJobs,
        pr_1001.head_sha
      );
      const comment = formDrciComment(1001, failureInfo);
      expect(comment.includes("1 Failures, 1 Pending")).toBeTruthy();
      expect(comment.includes("Helpful Links")).toBeTruthy();
      expect(
        comment.includes("This comment was automatically generated by Dr. CI")
      ).toBeTruthy();
    });

    test("test getActiveSevs function", async () => {
      expect(
        (await getActiveSEVs([sev, closedSev])).includes(
          "## :heavy_exclamation_mark: 1 Active SEVs"
        )
      ).toBeTruthy();
      expect(
        (await getActiveSEVs([sev, mergeBlockingSev])).includes(
          "## :heavy_exclamation_mark: 1 Merge Blocking SEVs"
        )
      ).toBeTruthy();
      expect((await getActiveSEVs([closedSev])) === "").toBeTruthy();
    });

    test("test dr ci comment with sevs", async () => {
      const originalWorkflows = [
        recentWorkflowA,
        recentWorkflowB,
        recentWorkflowC,
      ];
      const workflowsByPR =
        updateDrciBot.reorganizeWorkflows(originalWorkflows);
      const pr_1001 = workflowsByPR.get(1001)!;
      const { pending, failedJobs } =
        updateDrciBot.getWorkflowJobsStatuses(pr_1001);

      const failureInfo = updateDrciBot.constructResultsComment(
        pending,
        failedJobs,
        pr_1001.head_sha
      );
      const comment = formDrciComment(
        1001,
        failureInfo,
        await getActiveSEVs([sev, mergeBlockingSev])
      );
      expect(comment.includes("## :link: Helpful Links"));
      expect(
        comment.includes("## :heavy_exclamation_mark: 1 Merge Blocking SEVs")
      );
      expect(comment.includes("## :x: 1 Failures, 1 Pending"));
    });
});
