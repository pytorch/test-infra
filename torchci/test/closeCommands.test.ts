import nock from "nock";
import * as probot from "probot";
import * as utils from "./utils";
import pytorchBot from "lib/bot/pytorchBot";
import { handleScope } from "./common";

nock.disableNetConnect();

describe("label-bot", () => {
  let probot: probot.Probot;

  const existingRepoLabelsResponse = require("./fixtures/known_labels.json");

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
});
