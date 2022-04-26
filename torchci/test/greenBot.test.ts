import nock from "nock";
import * as utils from "./utils";
import pingBot, { LAND_PENDING } from "../lib/bot/greenBot";
import * as probot from "probot";

nock.disableNetConnect();

function getPostCommentUri(owner: string, repo: string, issue_number: string) {
  return `/repos/${owner}/${repo}/issues/${issue_number}/comments`;
}
function getPostReactionUri(
  owner: string,
  repo: string,
  comment_number: string
) {
  return `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`;
}
function getCheckRunUri(owner: string, repo: string, commit: string) {
  return `/repos/${owner}/${repo}/commits/${commit}/check-runs?per_page=100`;
}
function getPostLabelUri(owner: string, repo: string, pr_number: string) {
  return `/repos/${owner}/${repo}/issues/${pr_number}/labels`;
}
function getPullUri(owner: string, repo: string, pr_number: string) {
  return `/repos/${owner}/${repo}/pulls/${pr_number}`;
}

function getDeleteLabelUri(
  owner: string,
  repo: string,
  pr_number: string,
  label: string
) {
  return `/repos/${owner}/${repo}/issues/${pr_number}/labels/${label}`;
}

function getPostDispatchUri(owner: string, repo: string) {
  return `/repos/${owner}/${repo}/dispatches`;
}

describe("Green Bot Tests", () => {
  let probot: probot.Probot;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(pingBot);
  });

  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  test("PR Comment Adds Label and Comment", async () => {
    const event = require("./fixtures/pull_request_comment.json");
    event.payload.comment.body = "@pytorchbot mergeOnGreen";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .post(getPostReactionUri(owner, repo, comment_number), (body) => {
        expect(JSON.stringify(body)).toContain('{"content":"+1"}');
        return true;
      })
      .reply(200, {})
      .post(getPostLabelUri(owner, repo, pr_number), (body) => {
        expect(JSON.stringify(body)).toContain('"labels":["land-pending"]');
        return true;
      })
      .reply(200, {});

    await probot.receive(event);
    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("Label recieved triggers merge", async () => {
    const payload = require("./fixtures/pull_request.labeled.json");
    payload.label.name = LAND_PENDING;
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const commit = payload.pull_request.head.sha;
    const pr_number = payload.pull_request.number;

    const scope = nock("https://api.github.com")
      .post(getPostLabelUri(owner, repo, pr_number))
      .reply(200, {})
      .delete(getDeleteLabelUri(owner, repo, pr_number, LAND_PENDING))
      .reply(200, {})
      .post(getPostDispatchUri(owner, repo))
      .reply(200, {})
      .post(getPostCommentUri(owner, repo, pr_number), (body) => {
        expect(JSON.stringify(body)).toContain(
          "All checks passed. Attempting to merge."
        );
        return true;
      })
      .reply(200, {});

    const rocksetScope = nock(new RegExp(".*rockset.*"))
      .post(new RegExp(".*workflow_jobs_for_sha.*"))
      .reply(200, { results: [{ name: "test_job", conclusion: "success" }] });

    await probot.receive({ name: "pull_request", payload, id: "2" });
    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    rocksetScope.done();
    scope.done();
  });

  test("Check run completed triggers merge", async () => {
    const payload = require("./fixtures/workflow_job_completed.json");

    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const prNumber = "2";

    const scope = nock("https://api.github.com")
      .post(getPostCommentUri(owner, repo, prNumber), (body) => {
        expect(JSON.stringify(body)).toContain(
          "All checks passed. Attempting to merge."
        );
        return true;
      })
      .reply(200, {})
      .post(getPostLabelUri(owner, repo, prNumber))
      .reply(200, {})
      .delete(getDeleteLabelUri(owner, repo, prNumber, LAND_PENDING))
      .reply(200, {})
      .post(getPostDispatchUri(owner, repo))
      .reply(200, {});

    const rocksetScope = nock(new RegExp(".*rockset.*"))
      .post(new RegExp(".*workflow_jobs_for_sha.*"))
      .reply(200, { results: [{ name: "test_job", conclusion: "success" }] })
      .post(new RegExp(".*prs_with_label.*"))
      .reply(200, { results: [{ sha: "testSha", number: prNumber }] });

    await probot.receive({ payload, name: "workflow_job", id: "2" });
    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
    rocksetScope.done();
  });
});
