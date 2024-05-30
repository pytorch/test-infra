import { RecentWorkflowsData } from "lib/types";
import _ from "lodash";
import getRocksetClient from "./rockset";

// NB: Surprisingly, jest cannot mock function in the same module so we need to
// keep this function here in its own module so that it can be mocked.  See the
// issue at https://github.com/jestjs/jest/issues/936
export async function getAuthors(jobs: RecentWorkflowsData[]): Promise<{
  [key: string]: {
    email: string;
    commit_username: string;
    pr_username: string;
  };
}> {
  if (jobs.length === 0) {
    return {};
  }

  // NB: Query both the committer email which is already part of the commit info and
  // the actual username available from the either the GitHub pull_request or push
  // events. We need both events because pull_request is when a PR is created while
  // push is for a commit is pushed in PR or committed into trunk
  const query = `
WITH email AS (
  SELECT
    w.head_commit.id AS sha,
    w.head_commit.author.email
  FROM
    commons.workflow_run w
  WHERE
    ARRAY_CONTAINS(
      SPLIT(: shas, ','),
      w.head_commit.id
    )
  GROUP BY
    sha,
    email
),
commit_username AS (
  SELECT
    p.after AS sha,
    p.head_commit.author.username
  FROM
    commons.push p
  WHERE
    ARRAY_CONTAINS(
      SPLIT(: shas, ','),
      p.after
    )
  GROUP BY
    sha,
    username
),
pr_username AS (
  SELECT
    pr.head.sha AS sha,
    pr.user.login
  FROM
    commons.pull_request pr
  WHERE
    ARRAY_CONTAINS(
      SPLIT(: shas, ','),
      pr.head.sha
    )
  GROUP BY
    sha,
    login
)
SELECT
  email.sha,
  email,
  IF(
    commit_username.username IS NULL,
    '', commit_username.username
  ) AS commit_username,
  IF(
    pr_username.login IS NULL, '', pr_username.login
  ) AS pr_username,
FROM
  email
  LEFT JOIN commit_username ON email.sha = commit_username.sha
  LEFT JOIN pr_username ON email.sha = pr_username.sha
  `;

  const rocksetClient = getRocksetClient();
  const results = (
    await rocksetClient.queries.query({
      sql: {
        query: query,
        parameters: [
          {
            name: "shas",
            type: "string",
            value: _.map(jobs, (job: RecentWorkflowsData) => job.head_sha).join(
              ","
            ),
          },
        ],
      },
    })
  ).results;

  return results !== undefined ? _.keyBy(results, (record) => record.sha) : {};
}
