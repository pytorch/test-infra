import nock from "nock";
import { Probot } from "probot";
import myProbotApp from "../lib/bot/cancelWorkflowsOnCloseBot";
import { handleScope, requireDeepCopy } from "./common";
import * as utils from "./utils";
nock.disableNetConnect();

describe("accept bot", () => {
  let probot: Probot;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(myProbotApp);
  });

  test("Cancel in progress workflows when not pytorchmergebot closes thr PR", async () => {
    // Got this response through the online graphql explorer
    const graphqlResponse = {
      repository: {
        pullRequest: {
          commits: {
            nodes: [
              {
                commit: {
                  checkSuites: {
                    nodes: [
                      {
                        status: "IN_PROGRESS",
                        workflowRun: {
                          databaseId: 6647495490,
                        },
                      },
                      {
                        status: "COMPLETED",
                        workflowRun: {
                          databaseId: 6647495493,
                        },
                      },
                      {
                        status: "IN_PROGRESS",
                        workflowRun: {
                          databaseId: 6647495495,
                        },
                      },
                      {
                        status: "COMPLETED",
                        workflowRun: {
                          databaseId: 6647495497,
                        },
                      },
                      {
                        status: "COMPLETED",
                        workflowRun: {
                          databaseId: 6647495505,
                        },
                      },
                      {
                        status: "COMPLETED",
                        workflowRun: {
                          databaseId: 6647495536,
                        },
                      },
                    ],
                  },
                },
              },
            ],
          },
        },
      },
    };
    const event = requireDeepCopy("./fixtures/pull_request.closed.json");
    const scope = nock("https://api.github.com")
      .post("/graphql")
      .reply(200, { data: graphqlResponse })
      .post(`/repos/clee2000/random-testing/actions/runs/6647495490/cancel`)
      .reply(200, {})
      .post(`/repos/clee2000/random-testing/actions/runs/6647495495/cancel`)
      .reply(200, {});
    await probot.receive(event);

    handleScope(scope);
  });

  test("Do not cancel in progress workflows when pytorchmergebot closes the PR", async () => {
    const event = requireDeepCopy("./fixtures/pull_request.closed.json");
    event.payload.sender.login = "pytorchmergebot";
    const scope = nock("https://api.github.com");
    await probot.receive(event);
    handleScope(scope);
  });
});
