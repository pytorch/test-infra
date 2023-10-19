-- This query is used by the HUD's /pull page to populate the list of historical commits
-- made against a given PR.
-- This improves upon the default github commits view because it allows HUD to show jobs 
-- that ran on a PR before it was rebased

WITH
-- Get all PRs that were merged into master, and get all the SHAs for commits from that PR which CI jobs ran against
-- We need the shas because some jobs (like trunk) don't have a PR they explicitly ran against, but they _were_ run against
-- a commit from a PR
pr_shas AS (
  SELECT DISTINCT
    p.head_commit.timestamp as timestamp,
    r.pull_requests[1].number AS pr_number,
    j.head_sha AS sha,
    p.head_commit.message,
    CONCAT(
      'https://github.com/',
      :owner,
      '/',
      :repo,
      '/',
      r.pull_requests[1].number
    ) AS pr_url,
    p.head_commit.url AS commit_url,
  FROM
    commons.workflow_job j
    INNER JOIN commons.workflow_run r ON j.run_id = r.id
    JOIN commons.push p ON p.head_commit.id = j.head_sha
  WHERE
    1 = 1
    AND LENGTH(r.pull_requests) = 1
    AND r.repository.owner.login = :owner
    AND r.pull_requests[1].head.repo.name = :repo
    AND r.pull_requests[1].number = :pr_num

)
SELECT
  *
FROM
  pr_shas
ORDER BY timestamp