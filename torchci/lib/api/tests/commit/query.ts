import type { CommitRunsCursor } from "lib/api/tests/commit/cursor";
import { CommitRunsListQuery } from "lib/api/tests/commit/parameters";
import { buildRunPageQuery, runSortKeys } from "lib/api/tests/test/runs/query";

export function buildCommitRunsQuery(
  query: CommitRunsListQuery,
  cursor: CommitRunsCursor | null
) {
  return buildRunPageQuery(
    query,
    cursor,
    commitRunsScope(query),
    runSortKeys(query, true)
  );
}

export function commitRunsScope(
  query: Pick<CommitRunsListQuery, "repo" | "sha">
) {
  return {
    params: { sha: query.sha, repo: query.repo },
    // Workflow IDs and their job associations are immutable; IN also removes
    // duplicate metadata rows. The commit's workflow runs are matched by
    // their head_sha and repository, every attempt included, and their jobs
    // read through materialized_views.workflow_job_by_head_sha, ordered by
    // head_sha, run_id and id: a job's head_sha is its run's (not one of
    // some 30 million jobs from July to November 2026 differed), so the
    // jobs of the commit's runs are the view's rows of the commit's SHA with
    // those runs' IDs. The job table is ordered by job ID, and finding jobs
    // by run ID there read every one of its 128 million rows, a gigabyte per
    // query (commit/query-validation.md, 2026-11-03).
    // A scalar subquery is cached for this query. A named table CTE would
    // repeat the workflow/job scan for each reference in the run query and
    // its metadata filters. Every request still discovers current membership.
    prefix: `
WITH (
    SELECT groupArray(id)
    FROM materialized_views.workflow_job_by_head_sha
    WHERE head_sha = {sha: String}
        AND run_id IN (
            SELECT id
            FROM default.workflow_run
            WHERE id IN (
                SELECT id
                FROM materialized_views.workflow_run_by_head_sha
                WHERE head_sha = {sha: String}
            )
                AND head_sha = {sha: String}
                AND repository.full_name = {repo: String}
        )
) AS matched_job_ids`,
    // The runs table's by_job projection indexes these jobs' runs. The shared
    // builders read them without FINAL and resolve replacements by key.
    filters: [
      "run.github_workflow_job_id IN (SELECT arrayJoin(matched_job_ids))",
    ],
    byJob: true,
  };
}
