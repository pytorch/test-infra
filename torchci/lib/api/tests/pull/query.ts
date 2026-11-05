import type { PullRequestQuery } from "lib/api/tests/pull/parameters";

// The two reads that find a pull request's newest head (head.ts), sent
// concurrently. Measurements and the check against GitHub are in
// query-validation.md beside this file.

// The pull request's latest retained record: the head it names, the head's
// repository and branch, the title and the page. The table holds every
// repository's pull requests under their own numbers, so the base
// repository picks the request's, as the commit summary's lookup does. One
// row or none.
export function buildPullRequestRecordQuery({
  number,
  repo,
}: PullRequestQuery) {
  return {
    params: { number, repo },
    sql: `
SELECT
    head.sha AS head_sha,
    head.repo.full_name AS head_repo,
    head.ref AS head_branch,
    title,
    html_url
FROM default.pull_request
WHERE number = {number: Int64}
    AND base.repo.full_name = {repo: String}
ORDER BY updated_at DESC
LIMIT 1
`,
  };
}

// Every head the pull request's records have named, with the id of its
// newest pull_request workflow run in the repository, per head repository
// and branch; run ids grow as runs are created. The heads come from
// materialized_views.pr_by_sha, which records the head of every row written
// to the pull_request table, so it keeps the heads a later row replaced.
// It has no repository column, so another repository's pull request with
// the same number adds its heads too; their runs are not in this
// repository, or not on this pull request's branch, which head.ts compares.
// The runs are found through the head_sha view and read by id: about 2
// million rows, nearly all of them the scan of pr_by_sha for the number,
// where reading the pull_request runs of every head read all 15 million
// runs (query-validation.md, 2026-11-05).
export function buildPullRequestHeadRunsQuery({
  number,
  repo,
}: PullRequestQuery) {
  return {
    params: { number, repo },
    sql: `
SELECT
    head_sha,
    head_repository.full_name AS head_repo,
    head_branch,
    max(id) AS newest_run_id
FROM default.workflow_run
WHERE id IN (
        SELECT id
        FROM materialized_views.workflow_run_by_head_sha
        WHERE head_sha IN (
            SELECT head_sha
            FROM materialized_views.pr_by_sha
            WHERE number = {number: Int64}
        )
    )
    AND event = 'pull_request'
    AND repository.full_name = {repo: String}
GROUP BY head_sha, head_repo, head_branch
`,
  };
}
