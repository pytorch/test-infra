import nock from "nock";
import { __forTesting__ as getDisabledTestsAndJobs } from "pages/api/flaky-tests/getDisabledTestsAndJobs";
import { handleScope } from "../common";
import * as utils from "../utils";
import {
  flakyTestA,
  genAggIssueFor,
  genAggTests,
  genSingleIssueFor,
} from "./flakyBotTestsUtils";

nock.disableNetConnect();

function mockGraphQLQuery(
  issues: {
    number: number;
    title: string;
    body: string;
    url: string;
    authorLogin: string;
  }[]
) {
  return nock("https://api.github.com")
    .post("/graphql", (body) => {
      return body.query.includes("search");
    })
    .reply(200, {
      data: {
        search: {
          issueCount: issues.length,
          pageInfo: { hasNextPage: false, endCursor: "" },
          nodes: issues.map((issue) => ({
            number: issue.number,
            title: issue.title,
            body: issue.body,
            url: issue.url,
            author: { login: issue.authorLogin },
          })),
        },
      },
    });
}

describe("Get disable/unstable job/test jsons", () => {
  const octokit = utils.testOctokit();
  beforeEach(() => {});

  afterEach(async () => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });
  test("Sanity check no results", async () => {
    const scope = [mockGraphQLQuery([]), mockGraphQLQuery([])];

    const result = await getDisabledTestsAndJobs.getDisabledTestsAndJobs(
      octokit
    );
    expect(result).toEqual({
      disabledTests: {},
      disabledJobs: {},
      unstableJobs: {},
    });

    handleScope(scope);
  });

  test("Throw error if result from graphql is inconsistent", async () => {
    // Number of tests != node list => throw error
    const scope = nock("https://api.github.com")
      .post("/graphql", (body) => {
        return body.query.includes("search");
      })
      .reply(200, {
        data: {
          search: {
            issueCount: 15,
            pageInfo: { hasNextPage: false, endCursor: "" },
            nodes: [],
          },
        },
      });

    await expect(
      getDisabledTestsAndJobs.getDisabledTestsAndJobs(octokit)
    ).rejects.toThrow();

    handleScope(scope);
  });

  test("One test", async () => {
    const issue = genSingleIssueFor(flakyTestA, {});
    const scope = [
      mockGraphQLQuery([
        {
          number: issue.number,
          title: issue.title,
          body: issue.body,
          url: "url",
          authorLogin: "pytorch-bot",
        },
      ]),
      mockGraphQLQuery([]),
    ];

    const result = await getDisabledTestsAndJobs.getDisabledTestsAndJobs(
      octokit
    );
    expect(result).toEqual({
      disabledTests: {
        "test_a (__main__.suite_a)": ["1", "url", ["win"]],
      },
      disabledJobs: {},
      unstableJobs: {},
    });

    handleScope(scope);
  });

  test("Two tests merge platforms", async () => {
    const issue = genSingleIssueFor(flakyTestA, {});
    const scope = [
      mockGraphQLQuery([
        {
          number: issue.number,
          title: issue.title,
          body: issue.body,
          url: "url",
          authorLogin: "pytorch-bot",
        },
        {
          number: 2,
          title: issue.title,
          body: "Platforms: linux",
          url: "url2",
          authorLogin: "pytorch-bot",
        },
      ]),
      mockGraphQLQuery([]),
    ];

    const result = await getDisabledTestsAndJobs.getDisabledTestsAndJobs(
      octokit
    );
    expect(result).toEqual({
      disabledTests: {
        "test_a (__main__.suite_a)": ["1", "url", ["linux", "win"]],
      },
      disabledJobs: {},
      unstableJobs: {},
    });

    handleScope(scope);
  });

  test("Many tests merge platforms: all", async () => {
    const issue = genSingleIssueFor(flakyTestA, {});
    const scope = [
      mockGraphQLQuery([
        {
          number: issue.number,
          title: issue.title,
          body: issue.body,
          url: "url",
          authorLogin: "pytorch-bot",
        },
        {
          number: 2,
          title: issue.title,
          body: "Platforms:",
          url: "url2",
          authorLogin: "pytorch-bot",
        },
        {
          number: 3,
          title: issue.title,
          body: "Platforms: linux",
          url: "url2",
          authorLogin: "pytorch-bot",
        },
        {
          number: 4,
          title: issue.title,
          body: "Platforms: mac",
          url: "url2",
          authorLogin: "pytorch-bot",
        },
      ]),
      mockGraphQLQuery([]),
    ];

    const result = await getDisabledTestsAndJobs.getDisabledTestsAndJobs(
      octokit
    );
    expect(result).toEqual({
      disabledTests: {
        "test_a (__main__.suite_a)": ["1", "url", []],
      },
      disabledJobs: {},
      unstableJobs: {},
    });

    handleScope(scope);
  });

  test("Malformed test -> job", async () => {
    const issue = genSingleIssueFor(flakyTestA, {});
    const scope = [
      mockGraphQLQuery([
        {
          number: issue.number,
          title: issue.title + " 2",
          body: issue.body + " 2",
          url: "url2",
          authorLogin: "pytorch-bot",
        },
      ]),
      mockGraphQLQuery([]),
    ];

    const result = await getDisabledTestsAndJobs.getDisabledTestsAndJobs(
      octokit
    );
    expect(result).toEqual({
      disabledTests: {},
      disabledJobs: {
        "test_a (__main__.suite_a) 2": [
          "pytorch-bot",
          "1",
          "url2",
          "test_a (__main__.suite_a) 2",
          "",
          "",
        ],
      },
      unstableJobs: {},
    });

    handleScope(scope);
  });

  test("disabled job", async () => {
    const scope = [
      mockGraphQLQuery([
        {
          number: 1,
          title: "DISABLED Lint / Link checks / lint-urls / linux-job",
          body: "",
          url: "url",
          authorLogin: "pytorch-bot",
        },
      ]),
      mockGraphQLQuery([]),
    ];

    const result = await getDisabledTestsAndJobs.getDisabledTestsAndJobs(
      octokit
    );
    expect(result).toEqual({
      disabledTests: {},
      disabledJobs: {
        "Lint / Link checks / lint-urls / linux-job": [
          "pytorch-bot",
          "1",
          "url",
          "Lint",
          "Link checks",
          "lint-urls / linux-job",
        ],
      },
      unstableJobs: {},
    });

    handleScope(scope);
  });

  test("unstable job", async () => {
    const scope = [
      mockGraphQLQuery([]),
      mockGraphQLQuery([
        {
          number: 1,
          title: "UNSTABLE Lint / Link checks / lint-urls / linux-job",
          body: "",
          url: "url",
          authorLogin: "pytorch-bot",
        },
      ]),
    ];

    const result = await getDisabledTestsAndJobs.getDisabledTestsAndJobs(
      octokit
    );
    expect(result).toEqual({
      disabledTests: {},
      disabledJobs: {},
      unstableJobs: {
        "Lint / Link checks / lint-urls / linux-job": [
          "pytorch-bot",
          "1",
          "url",
          "Lint",
          "Link checks",
          "lint-urls / linux-job",
        ],
      },
    });

    handleScope(scope);
  });

  test("unstable/disable mix up", async () => {
    const scope = [
      mockGraphQLQuery([
        {
          number: 1,
          title: "UNSTABLE Lint / Link checks / lint-urls / linux-job",
          body: "",
          url: "url",
          authorLogin: "pytorch-bot",
        },
      ]),
      mockGraphQLQuery([
        {
          number: 1,
          title: "DISABLED Lint / Link checks / lint-urls / linux-job",
          body: "",
          url: "url",
          authorLogin: "pytorch-bot",
        },
      ]),
    ];

    const result = await getDisabledTestsAndJobs.getDisabledTestsAndJobs(
      octokit
    );
    expect(result).toEqual({
      disabledTests: {},
      disabledJobs: {},
      unstableJobs: {},
    });

    handleScope(scope);
  });

  test("aggregate issue", async () => {
    const issue = genAggIssueFor(genAggTests(flakyTestA), {});
    const scope = [
      mockGraphQLQuery([
        {
          number: 1,
          title: issue.title,
          body: issue.body,
          url: "url",
          authorLogin: "pytorch-bot",
        },
      ]),
      mockGraphQLQuery([]),
    ];

    const result = await getDisabledTestsAndJobs.getDisabledTestsAndJobs(
      octokit
    );
    expect(Object.keys(result.disabledTests).length).toBe(11);
    expect(result.disabledTests["test_5 (__main__.suite_5)"]).toEqual([
      "1",
      "url",
      ["win"],
    ]);
    handleScope(scope);
  });

  describe("aggregate issue tests", () => {
    const aggTests = genAggTests(flakyTestA);
    const aggregateIssue = genAggIssueFor(aggTests, {});
    const singleIssue = genSingleIssueFor(aggTests[5], {});

    test("aggregate issue and single issue", async () => {
      const scope = [
        mockGraphQLQuery([
          {
            number: 1,
            title: aggregateIssue.title,
            body: aggregateIssue.body,
            url: "url",
            authorLogin: "pytorch-bot",
          },
          {
            number: 2,
            title: singleIssue.title,
            body: "Platforms: linux",
            url: "url2",
            authorLogin: "pytorch-bot",
          },
        ]),
        mockGraphQLQuery([]),
      ];

      const result = await getDisabledTestsAndJobs.getDisabledTestsAndJobs(
        octokit
      );
      expect(Object.keys(result.disabledTests).length).toBe(11);
      expect(result.disabledTests["test_5 (__main__.suite_5)"]).toEqual([
        "1",
        "url",
        ["linux", "win"],
      ]);
      handleScope(scope);
    });

    test("aggregate issue and single issue, all platforms", async () => {
      const scope = [
        mockGraphQLQuery([
          {
            number: 1,
            title: aggregateIssue.title,
            body: aggregateIssue.body,
            url: "url",
            authorLogin: "pytorch-bot",
          },
          {
            number: 2,
            title: singleIssue.title,
            body: "Platforms:",
            url: "url2",
            authorLogin: "pytorch-bot",
          },
        ]),
        mockGraphQLQuery([]),
      ];

      const result = await getDisabledTestsAndJobs.getDisabledTestsAndJobs(
        octokit
      );
      expect(Object.keys(result.disabledTests).length).toBe(11);
      expect(result.disabledTests["test_5 (__main__.suite_5)"]).toEqual([
        "1",
        "url",
        [],
      ]);
      handleScope(scope);
    });
  });
});
