-- This query is used by Dr.CI to enumerate every job that ran on the merge-base
-- commit, regardless of conclusion. It is used to distinguish "this job failed
-- on base" (broken trunk), "this job passed on base" (PR-introduced regression),
-- and "this job did not run on base at all" (no signal -> Unknown).
SELECT DISTINCT
  j.head_sha AS head_sha,
  CONCAT(j.workflow_name, ' / ', j.name) AS name
FROM
  default.workflow_job j final
WHERE
  j.id in (select id from materialized_views.workflow_job_by_head_sha where head_sha in {shas: Array(String)})
