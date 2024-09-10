import { RecentWorkflowsData } from "lib/types";
import _ from "lodash";
import { queryClickhouse } from "./clickhouse";

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
SELECT
  sha,
  email,
  username AS commit_username,
  login as pr_username
FROM
  materialized_views.commit_authors final
where
  sha in {shas: Array(String)}
  `;

  const results = await queryClickhouse(query, {
    shas: _.map(jobs, (job: RecentWorkflowsData) => job.head_sha),
  });

  return _.keyBy(results, (record) => record.sha);
}
