import nock from "nock";
import * as probot from "probot";
import * as utils from "./utils";
import pytorchBot from "lib/bot/pytorchBot";
import { handleScope } from "./common";

nock.disableNetConnect();

describe("label-bot", () => {
  let probot: probot.Probot;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(pytorchBot);
  });

  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  test("close pr with pytorchbot", async () => {
    const event = require("./fixtures/pull_request_comment.json");
    event.payload.comment.body = "@pytorchbot close";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const issue_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;

    const scope = nock("https://api.github.com")
      .patch(`/repos/${owner}/${repo}/pulls/${issue_number}`, (body) => {
        expect(JSON.stringify(body)).toContain(`{"state":"closed"}`);
        return true;
      })
      .reply(200, {})
      .post(
        `/repos/${owner}/${repo}/issues/${issue_number}/comments`,
        (body) => {
          expect(JSON.stringify(body)).toContain(
            `{"body":"Closing this pull request!`
          );
          return true;
        }
      )
      .reply(200, {});
    await probot.receive(event);
    handleScope(scope);
  });

  test("close issue with pytorchbot", async () => {
    const event = require("./fixtures/issue_comment.json");
    event.payload.comment.body = "@pytorchbot close";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const issue_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;

    const scope = nock("https://api.github.com")
      .patch(`/repos/${owner}/${repo}/issues/${issue_number}`, (body) => {
        expect(JSON.stringify(body)).toContain(`{"state":"closed"}`);
        return true;
      })
      .reply(200, {})
      .post(
        `/repos/${owner}/${repo}/issues/${issue_number}/comments`,
        (body) => {
          expect(JSON.stringify(body)).toContain(
            `{"body":"Closing this issue!`
          );
          return true;
        }
      )
      .reply(200, {});
    await probot.receive(event);
    handleScope(scope);
  });
});
