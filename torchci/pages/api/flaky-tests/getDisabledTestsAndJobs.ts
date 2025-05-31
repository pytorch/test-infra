import { parseTitle } from "lib/bot/verifyDisableTestIssueBot";
import * as aggregateDisableIssue from "lib/flakyBot/aggregateDisableIssue";
import * as singleDisableIssue from "lib/flakyBot/singleDisableIssue";
import { parseTestName } from "lib/flakyBot/utils";
import { hasWritePermissionsUsingOctokit } from "lib/GeneralUtils";
import { getOctokit } from "lib/github";
import _ from "lodash";
import type { NextApiRequest, NextApiResponse } from "next";
import { Octokit } from "octokit";

const PYTORCH = "pytorch";

const GRAPHQL_QUERY = `
query ($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 100, after: $cursor) {
    issueCount
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      ... on Issue {
        number
        title
        body
        url
        author {
          login
        }
      }
    }
  }
}
`;

interface IssueData {
  number: number;
  title: string;
  body: string;
  url: string;
  author: { login: string };
}

interface GraphQLResponse {
  search: {
    issueCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string };
    nodes: IssueData[];
  };
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const authorization = req.headers.authorization;
  if (authorization === process.env.FLAKY_TEST_BOT_KEY) {
    res.status(200).json(await getDisabledTestsAndJobs());
  } else {
    res.status(403).end();
  }
}

async function getDisabledTestsAndJobs() {
  const octokit = await getOctokit(PYTORCH, PYTORCH);
  const disableIssues = await getIssues(octokit, "DISABLED");
  const unstableIssues = await getIssues(octokit, "UNSTABLE");
  const { disableTestIssues, disableJobIssues } =
    filterDisableIssues(disableIssues);

  return {
    disabledTests: getDisabledTests(disableTestIssues),
    disabledJobs: await condenseJobs(octokit, disableJobIssues, "DISABLED"),
    unstableJobs: await condenseJobs(octokit, unstableIssues, "UNSTABLE"),
  };
}

async function getIssues(octokit: Octokit, prefix: string) {
  const issues: IssueData[] = [];
  let cursor: string | null = null;
  let totalCount = undefined;

  do {
    const res: GraphQLResponse = await octokit.graphql<GraphQLResponse>(
      GRAPHQL_QUERY,
      {
        q: `is:issue is:open repo:${PYTORCH}/${PYTORCH} in:title ${prefix}`,
        cursor,
      }
    );
    totalCount = res.search.issueCount;

    issues.push(...res.search.nodes);
    cursor = res.search.pageInfo.hasNextPage
      ? res.search.pageInfo.endCursor
      : null;
  } while (cursor);

  if (issues.length !== totalCount) {
    console.warn(
      `Expected ${totalCount} issues with prefix "${prefix}", but found ${issues.length}.`
    );
  }

  return issues.sort((a, b) => a.url.localeCompare(b.url));
}

function filterDisableIssues(issues: IssueData[]) {
  const disableTestIssues = [];
  const disableJobIssues = [];

  for (const issue of issues) {
    if (
      singleDisableIssue.isSingleIssue(issue.title) ||
      aggregateDisableIssue.isAggregateIssue(issue.title)
    ) {
      disableTestIssues.push(issue);
    } else {
      disableJobIssues.push(issue);
    }
  }
  return { disableTestIssues, disableJobIssues };
}

function getDisabledTests(issues: IssueData[]) {
  interface ParsedDisableTestInfo {
    number: number;
    url: string;
    platforms: string[];
  }
  const disabledTests = new Map<string, ParsedDisableTestInfo>();

  function updateMap(
    name: string,
    number: number,
    url: string,
    platformsToSkip: string[]
  ) {
    const existing = disabledTests.get(name);
    if (existing === undefined) {
      disabledTests.set(name, { number, url, platforms: platformsToSkip });
    } else if (platformsToSkip.length === 0) {
      existing.platforms = [];
    } else if (existing.platforms.length !== 0) {
      existing.platforms.push(...platformsToSkip);
    }
  }
  for (const issue of issues) {
    if (singleDisableIssue.isSingleIssue(issue.title)) {
      const { platformsToSkip } = singleDisableIssue.parseBody(issue.body);
      const name = parseTestName(issue.title.substring("DISABLED ".length));
      if (name === undefined) {
        console.warn(`Failed to parse test name from issue: ${issue.title}`);
        continue;
      }
      updateMap(name, issue.number, issue.url, platformsToSkip);
    } else if (aggregateDisableIssue.isAggregateIssue(issue.title)) {
      const { platformMapping } = aggregateDisableIssue.parseBody(issue.body);
      for (const [test, platforms] of platformMapping.entries()) {
        const name = parseTestName(test);
        if (name === undefined) {
          console.warn(`Failed to parse test name from issue: ${issue.title}`);
          continue;
        }
        updateMap(name, issue.number, issue.url, platforms);
      }
    }
  }

  // Convert to object
  disabledTests.forEach((info) => {
    info.platforms = Array.from(new Set(info.platforms)).sort();
  });

  return Object.fromEntries(
    [...disabledTests.entries()].map(([name, info]) => [
      name,
      [info.number.toString(), info.url, info.platforms],
    ])
  );
}

const hasPermission = _.memoize(async (username: string, octokit: Octokit) => {
  // Check if the user has write permissions to the repository
  return await hasWritePermissionsUsingOctokit(
    octokit,
    username,
    PYTORCH,
    PYTORCH
  );
});

async function condenseJobs(
  octokit: Octokit,
  issues: IssueData[],
  prefix: "DISABLED" | "UNSTABLE"
) {
  const jobs = new Map<
    string,
    {
      username: string;
      number: number;
      url: string;
      workflowName: string;
      platformName: string;
      configName: string;
    }
  >();
  for (const issue of issues) {
    if (issue.title.startsWith(prefix)) {
      const jobName = parseTitle(issue.title, prefix);
      if (jobName === undefined) {
        console.warn(`Failed to parse job name from issue: ${issue.title}`);
        continue;
      }

      // Check if the author is the bot or has permission
      if (
        issue.author.login !== "pytorch-bot" &&
        !(await hasPermission(issue.author.login, octokit))
      ) {
        continue;
      }

      const parts = jobName.split("/");
      jobs.set(jobName, {
        username: issue.author.login,
        number: issue.number,
        url: issue.url,
        workflowName: parts[0].trim(),
        platformName: (parts[1] || "").trim(),
        configName: parts.slice(2).join("/").trim(),
      });
    }
  }

  // Convert to object

  return Object.fromEntries(
    [...jobs.entries()].map(([name, info]) => [
      name,
      [
        info.username,
        info.number.toString(),
        info.url,
        info.workflowName,
        info.platformName,
        info.configName,
      ],
    ])
  );
}

export const __forTesting__ = {
  getDisabledTestsAndJobs,
};
