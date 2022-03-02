import nock from "nock";
import * as probot from "probot";
import * as utils from "./utils";
import mergeBot from "../lib/bot/mergeBot";

nock.disableNetConnect();

describe("merge-bot", () => {
  let probot: probot.Probot;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(mergeBot);
  });

  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  test("random comment no event", async() => {
    const event = require("./fixtures/pull_request_comment.json");
    const scope = nock("https://api.github.com");
    await probot.receive(event);
    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("merge this comment on issue triggers confused reaction", async() => {
    const event = require("./fixtures/issue_comment.json");
    event.payload.comment.body = "@pytorchbot merge this";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const comment_number = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain(
            "{\"content\":\"confused\"}"
          );
          return true;
        }
      )
      .reply(200, {})
      ;

    await probot.receive(event);
    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("merge this comment on pull request triggers dispatch and like", async() => {
    const event = require("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot merge this";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain(
            "{\"content\":\"+1\"}"
          );
          return true;
        }
      )
      .reply(200, {})
      .post(
        `/repos/${owner}/${repo}/dispatches`,
        (body) => {
          expect(JSON.stringify(body)).toContain(
            `{"event_type":"try-merge","client_payload":{"pr_num":${pr_number}}}`
          );
          return true;
        }
      )
      .reply(200, {})
      ;
      ;

    await probot.receive(event);
    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });
});
