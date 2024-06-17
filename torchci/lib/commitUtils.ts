import getRocksetClient from "lib/rockset";

const ELIGIBLE_COMMITS_FOR_SIMILAR_FAILURE_CHECK: { [sha: string]: boolean } =
  {};

export async function isEligibleCommitForSimilarFailureCheck(
  sha: string
): Promise<boolean> {
  if (sha in ELIGIBLE_COMMITS_FOR_SIMILAR_FAILURE_CHECK) {
    return ELIGIBLE_COMMITS_FOR_SIMILAR_FAILURE_CHECK[sha];
  }

  // We will narrow down the similar failure check to only failures from the following two
  // categories.
  //   - Trunk
  //   - Or the last commit from a PR that has already been merged
  // Any other commits represent a work in progress, which could be used but only when we
  // have a more reliable CI.
  const query = `
SELECT DISTINCT
  last_commit_sha,
  merge_commit_sha,
  _event_time
FROM
  commons.merges
WHERE
  (
    last_commit_sha = : sha
    AND merge_commit_sha != ''
  )
  OR merge_commit_sha = : sha
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
            value: sha,
          },
        ],
      },
    })
  ).results;

  ELIGIBLE_COMMITS_FOR_SIMILAR_FAILURE_CHECK[sha] =
    results !== undefined && results.length !== 0 ? true : false;
  return ELIGIBLE_COMMITS_FOR_SIMILAR_FAILURE_CHECK[sha];
}
