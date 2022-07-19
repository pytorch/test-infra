import nock from "nock";
import * as utils from "./utils";
import * as updateDrciBot from "../pages/api/drci/drci";
import * as drciUtils from "lib/drciUtils";

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

    test("Check that reorganizeWorkflows works correctly", async () => {
        const originalWorkflows = [recentWorkflowA, recentWorkflowB, recentWorkflowC];
        const workflowsByPR = updateDrciBot.reorganizeWorkflows(originalWorkflows);
        expect(workflowsByPR.length).toBe(2);
        expect(workflowsByPR[0].jobs.length).toBe(1);
        expect(workflowsByPR[1].jobs.length).toBe(2);
    });

    test("Check that getWorkflowAnalysis works correctly", async () => {
        const originalWorkflows = [recentWorkflowA, recentWorkflowB, recentWorkflowC];
        const workflowsByPR = updateDrciBot.reorganizeWorkflows(originalWorkflows);
        const { failing, pending, failedJobs } = await updateDrciBot.getWorkflowAnalysis(workflowsByPR[1]);
        expect(failing).toBe(1);
        expect(pending).toBe(1);
        expect(failedJobs.length).toBe(1);
    });

    test("Check that dr ci comment is correctly formed", async () => {
        const comment = drciUtils.formDrciComment(recentWorkflowA.pr_number);
        expect(comment.includes(drciUtils.DRCI_COMMENT_START)).toBeTruthy();
        expect(
            comment.includes("See artifacts and rendered test results")
        ).toBeTruthy();
        expect(
            comment.includes("Need help or want to give feedback on the CI?")
        ).toBeTruthy();
        expect(comment.includes(drciUtils.OH_URL)).toBeTruthy();
        expect(comment.includes(drciUtils.DOCS_URL)).toBeTruthy();
    });
});
