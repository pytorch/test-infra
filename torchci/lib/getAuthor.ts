import { RecentWorkflowsData } from "lib/types";
import getRocksetClient from "./rockset";

// NB: Surprisingly, jest cannot mock function in the same module so we need to
// keep this function here in its own module so that it can be mocked.  See the
// issue at https://github.com/jestjs/jest/issues/936
export async function getAuthor(
  job: RecentWorkflowsData
): Promise<{ email: string; commit_username: string; pr_username: string }> {
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
    w.head_commit.id = :sha
  LIMIT
    1
),
commit_username AS (
  SELECT
    p.after AS sha,
    p.head_commit.author.username
  FROM
    commons.push p
  WHERE
    p.after = :sha
  LIMIT
    1
),
pr_username AS (
  SELECT
    pr.head.sha AS sha,
    pr.user.login
  FROM
    commons.pull_request pr
  WHERE
    pr.head.sha = :sha
  LIMIT
    1
)
SELECT
  email,
  IF(commit_username.username IS NULL, '', commit_username.username) AS commit_username,
  IF(pr_username.login IS NULL, '', pr_username.login) AS pr_username,
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
            name: "sha",
            type: "string",
            value: job.head_sha,
          },
        ],
      },
    })
  ).results;
  return results !== undefined && results.length === 1
    ? {
        email: results[0].email,
        commit_username: results[0].commit_username,
        pr_username: results[0].pr_username,
      }
    : { email: "", commit_username: "", pr_username: "" };
}
