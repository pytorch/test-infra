-- This query is used by the HUD's /pull page to populate the list of historical commits
-- made against a given PR.
-- This improves upon the default github commits view because it allows HUD to show jobs
-- that ran on a PR before it was rebased

WITH
-- Get all PRs that were merged into master, and get all the SHAs for commits from that PR which CI jobs ran against
-- We need the shas because some jobs (like trunk) don't have a PR they explicitly ran against, but they _were_ run against
-- a commit from a PR
shas as (
  SELECT DISTINCT
    r.pull_requests[1].'number' AS pr_number,
    r.head_sha AS sha,
    CONCAT(
      'https://github.com/',
      {owner: String},
      '/',
      {repo: String},
      '/pull/',
      r.pull_requests[1].'number'
    ) AS pr_url
  FROM
    default.workflow_run r final
  WHERE
    LENGTH(r.pull_requests) = 1
    AND r.repository.'owner'.'login' = {owner: String}
    AND r.pull_requests[1].'head'.'repo'.'name' = {repo: String}
    AND r.pull_requests[1].'number' = {pr_num: Int64}
    and r.id in (select id from materialized_views.workflow_run_by_pr_num where pr_number = {pr_num: Int64})
),
shas_with_info AS (
  SELECT DISTINCT
    p.head_commit.'timestamp' as timestamp,
    s.pr_number AS pr_number,
    s.pr_url as pr_url,
    p.head_commit.'id' AS sha,
    p.head_commit.'message' as message,
    p.head_commit.url AS commit_url
  FROM
    default.push p final
    JOIN shas s ON p.head_commit.id = s.sha
  -- Make the query faster by using a materialized view with a more relevant primary key
  where p.head_commit.'timestamp' in (select timestamp from materialized_views.push_by_sha where id in (select sha from shas))
)
SELECT
  *
FROM
  shas_with_info
ORDER BY timestamp
