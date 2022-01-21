import { promises as fs } from "fs";
import nock from "nock";
import { Probot } from "probot";

import * as utils from "./utils";
import * as triggerCircleBot from "../lib/bot/triggerCircleCIWorkflows";

nock.disableNetConnect();

const EXAMPLE_CONFIG = `
labels_to_circle_params:
  ci/binaries:
    parameter: run_binaries_tests
    default_true_on:
      branches:
        - nightly
        - ci-all/.*
      tags:
        - v[0-9]+(\.[0-9]+)*-rc[0-9]+
  ci/default:
    parameter: default
    default_true_on:
      branches:
        - master
      pull_request:
  ci/bleh:
    parameter: run_bleh_tests
  ci/foo:
    parameter: run_foo_tests
`;

interface Example {
  payload: object;
  endpoint: string;
}

// Prior to the existence of this `prepare` function, the tests in this suite
// were failing in very strange ways when run together (but not when run in
// isolation). This seemed to be caused by the fact that all the tests were
// `nock`ing the same endpoint of the same CircleCI URL, so one test would
// receive the CircleCI parameters that corresponded to a different test. No
// idea how CI was previously passing on `master`. Anyway, this fixes the issue
// by enforcing that every test rename the example repo to a unique name,
// resulting in a unique CircleCI endpoint.
const usedNames: Set<string> = new Set();
async function prepare(fixture: string, repoName: string): Promise<Example> {
  expect(usedNames.has(repoName)).toBe(false);
  usedNames.add(repoName);
  const repoFullName = `seemethere/${repoName}`;
  utils.mockConfig(triggerCircleBot.configName, EXAMPLE_CONFIG, repoFullName);
  const payload = JSON.parse(
    (await fs.readFile(`test/fixtures/${fixture}.json`, "utf8")).replace(
      /test-repo/g,
      repoName
    )
  );
  const endpoint = triggerCircleBot.circlePipelineEndpoint(repoFullName);
  return { payload, endpoint };
}

describe("trigger-circleci-workflows", () => {
  let probot: Probot;
  let payload: object;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(triggerCircleBot.myBot);
    process.env.CIRCLE_TOKEN = "dummy_token";
    utils.mockAccessToken();
  });

  afterEach(() => {
    // Cleanup environment variables after the fact
    delete process.env.CIRCLE_TOKEN;
  });

  test("test with pull_request.labeled (specific labels)", async () => {
    const { payload, endpoint } = await prepare(
      "pull_request.labeled",
      "pr-labeled-specific"
    );
    // @ts-ignore
    payload["pull_request"]["number"] = 1;
    // @ts-ignore
    payload["pull_request"]["head"]["ref"] = "test_branch";
    // @ts-ignore
    payload["pull_request"]["labels"] = [
      { name: "ci/binaries" },
      { name: "ci/bleh" },
    ];
    const scope = nock(`${triggerCircleBot.circleAPIUrl}`)
      .post(endpoint, (body: any) => {
        expect(body).toStrictEqual({
          branch: "test_branch",
          parameters: {
            run_binaries_tests: true,
            run_bleh_tests: true,
            default: true,
          },
        });
        return true;
      })
      .reply(201);

    // @ts-ignore
    await probot.receive({ name: "pull_request", payload, id: "2" });

    expect(scope.isDone()).toBe(true);
  });

  test("test with pull_request.labeled (fork) (specific labels)", async () => {
    const { payload, endpoint } = await prepare(
      "pull_request.labeled",
      "pr-labeled-fork-specific"
    );
    // @ts-ignore
    payload["pull_request"]["head"]["repo"]["fork"] = true;
    // @ts-ignore
    payload["pull_request"]["number"] = 1;
    // @ts-ignore
    payload["pull_request"]["head"]["ref"] = "test_branch";
    // @ts-ignore
    payload["pull_request"]["labels"] = [
      { name: "ci/binaries" },
      { name: "ci/no-default" },
      { name: "ci/bleh" },
    ];
    const scope = nock(`${triggerCircleBot.circleAPIUrl}`)
      .post(endpoint, (body: any) => {
        expect(body).toStrictEqual({
          branch: "pull/1/head",
          parameters: {
            run_binaries_tests: true,
            run_bleh_tests: true,
          },
        });
        return true;
      })
      .reply(201);

    // @ts-ignore
    await probot.receive({ name: "pull_request", payload, id: "2" });

    expect(scope.isDone()).toBe(true);
  });

  test("test with push (refs/heads/nightly)", async () => {
    const { payload, endpoint } = await prepare("push", "push-nightly");
    // @ts-ignore
    payload["ref"] = "refs/heads/nightly";
    const scope = nock(`${triggerCircleBot.circleAPIUrl}`)
      .post(endpoint, (body: any) => {
        expect(body).toStrictEqual({
          branch: "nightly",
          parameters: {
            run_binaries_tests: true,
          },
        });
        return true;
      })
      .reply(201);

    // @ts-ignore
    await probot.receive({ name: "push", payload, id: "2" });

    scope.done();
  });

  test("test with push (refs/heads/ci-all/bleh)", async () => {
    const { payload, endpoint } = await prepare("push", "push-all-bleh");
    // @ts-ignore
    payload["ref"] = "refs/heads/ci-all/bleh";
    const scope = nock(`${triggerCircleBot.circleAPIUrl}`)
      .post(endpoint, (body: any) => {
        expect(body).toStrictEqual({
          branch: "ci-all/bleh",
          parameters: {
            run_binaries_tests: true,
          },
        });
        return true;
      })
      .reply(201);

    // @ts-ignore
    await probot.receive({ name: "push", payload, id: "2" });

    scope.done();
  });

  test("test with push (/refs/tags/v1.5.0-rc1)", async () => {
    const { payload, endpoint } = await prepare("push", "push-tag-rc");
    // @ts-ignore
    payload["ref"] = "refs/tags/v1.5.0-rc1";
    const scope = nock(`${triggerCircleBot.circleAPIUrl}`)
      .post(endpoint, (body: any) => {
        expect(body).toStrictEqual({
          tag: "v1.5.0-rc1",
          parameters: {
            run_binaries_tests: true,
          },
        });
        return true;
      })
      .reply(201);

    // @ts-ignore
    await probot.receive({ name: "push", payload, id: "2" });

    scope.done();
  });
});
