import nock from "nock";
import { Probot } from "probot";
import zlib from "zlib";
import * as bot from "../lib/bot/webhookToDynamo";
import * as dynamo from "../lib/dynamo";
import { requireDeepCopy } from "./common";
import * as utils from "./utils";

nock.disableNetConnect();
jest.mock("uuid", () => ({ v4: () => "fake-uuid" }));

describe("webhookToDynamo tests", () => {
  let probot: Probot;
  let expectedResults: { [key: string]: any };
  let returnedResults: { [key: string]: any };
  const resultsFile = "./test/fixtures/webhookToDynamoExpected.json.gz";

  function saveResult(filename: string, body: any) {
    returnedResults[filename] = body;
  }

  beforeAll(() => {
    expectedResults = JSON.parse(
      zlib.gunzipSync(require("fs").readFileSync(resultsFile)).toString()
    );
    returnedResults = {};
  });

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(bot.default);
    nock.cleanAll();
    jest.clearAllMocks();
  });

  afterAll(() => {
    // To save the file again, uncomment the following lines
    const zipped = zlib.gzipSync(JSON.stringify(returnedResults));
    require("fs").writeFileSync(resultsFile, zipped);
  });

  /**
   *
   * @param filename
   * @param name Name of the webhook event, ex "pull_request", "issue",
   * "workflow_job".  This is the X-GitHub-Event header.  Files that take the
   * form {"name": something, "id": something, "payload": something} should not
   * include this.
   */
  async function helper(
    filename: string,
    name: string | undefined = undefined
  ) {
    const event = requireDeepCopy(filename);
    const mockedPut = jest.fn();
    jest.spyOn(dynamo, "getDynamoClient").mockReturnValue({
      put: mockedPut,
    } as any);
    if (name) {
      await probot.receive({ name: name as any, payload: event, id: "2" });
    } else {
      await probot.receive(event);
    }
    expect(mockedPut.mock.calls.length).toBe(1);
    const body = mockedPut.mock.calls[0];
    saveResult(filename, body);
    expect(body).toEqual(expectedResults[filename]);
  }

  test("workflow_run.completed", async () => {
    const fileName = "./fixtures/workflow_run.completed.json";
    await helper(fileName);
  });

  test("workflow_job.queued", async () => {
    const filename = "./fixtures/workflow_job.queued.json";
    await helper(filename);
  });

  test("pull_request.labeled", async () => {
    const filename = "./fixtures/pull_request.labeled.json";
    await helper(filename, "pull_request");
  });

  test("issue.opened", async () => {
    const filename = "./fixtures/issues.opened.json";
    await helper(filename, "issues");
  });

  test("pull_request_review", async () => {
    const filename = "./fixtures/pull_request_review.json";
    await helper(filename);
  });

  test("issue_comment", async () => {
    const filename = "./fixtures/issue_comment.json";
    await helper(filename);
  });
});
