import nock from "nock";
import * as utils from "./utils";
import * as updateDrciBot from "../pages/api/drci/drci";

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
    conclusion: "success",
    completed_at: '2022-07-13T19:34:03Z',
    html_url: "abcdefg",
    head_sha: "abcdefg",
    pr_number: 1000,
    owner_login: "notswang392",
}


describe("Update Dr. CI Bot Integration Tests", () => {
    const octokit = utils.testOctokit();

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
    const octokit = utils.testOctokit();

    beforeEach(() => { });

    afterEach(() => {
        nock.cleanAll();
        jest.restoreAllMocks();
    });

    test("Check that dr ci comment is correctly formed", async () => {
        const comment = updateDrciBot.formDrciComment(recentWorkflowA.pr_number);
        expect(comment.includes(updateDrciBot.drciCommentStart)).toBeTruthy();
        expect(
            comment.includes("See artifacts and rendered test results")
        ).toBeTruthy();
        expect(
            comment.includes("Need help or want to give feedback on the CI?")
        ).toBeTruthy();
        expect(comment.includes(updateDrciBot.officeHoursUrl)).toBeTruthy();
        expect(comment.includes(updateDrciBot.docsBuildsUrl)).toBeTruthy();
    });
});
