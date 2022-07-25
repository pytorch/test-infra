import nock from "nock";
import * as utils from "./utils";
import * as updateDrciBot from "../pages/api/drci/drci";
import { OH_URL, DOCS_URL, DRCI_COMMENT_START, formDrciComment } from "lib/drciUtils";

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
    job_name: 'Lint / lintrunner (pull_request)',
    conclusion: "failure",
    completed_at: '2022-07-13T19:34:03Z',
    html_url: "abcdefg",
    head_sha: "abcdefg",
    pr_number: 1001,
    owner_login: "notswang392",
}

describe("Update Dr. CI Bot Integration Tests", () => {
    beforeEach(() => { });

    afterEach(() => {
        nock.cleanAll();
        jest.restoreAllMocks();
    });

    test("comment updated when user is swang392", async () => {

    });

    test("comment not updated when user is swang392", async () => {

    });
});

describe("Update Dr. CI Bot Unit Tests", () => {
    beforeEach(() => { });

    afterEach(() => {
        nock.cleanAll();
        jest.restoreAllMocks();
    });

    test("Check that constructFailureAnalysis works correctly", async () => {
        const originalWorkflows = [recentWorkflowA, recentWorkflowB, recentWorkflowC];
        const workflowsByPR = updateDrciBot.reorganizeWorkflows(originalWorkflows);
        const pr_1001 = workflowsByPR.get(1001)!;
        const { pending, failedJobs } = updateDrciBot.getWorkflowJobsStatuses(pr_1001);
        const failureInfo = updateDrciBot.constructResultsComment(pending, failedJobs, pr_1001.head_sha);
        const failedJobName = recentWorkflowC.job_name;

        expect(failureInfo.includes("1 Failures, 1 Pending")).toBeTruthy();
        expect(failureInfo.includes(failedJobName)).toBeTruthy();
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
        const comment = formDrciComment(recentWorkflowA.pr_number, "");
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
});
