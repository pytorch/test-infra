import type { CommitRunsCursor } from "lib/api/tests/commit/cursor";
import { CommitRunsListQuery } from "lib/api/tests/commit/parameters";
import {
  buildRunPageQuery,
  buildRunStatsQuery,
  runSortKeys,
} from "lib/api/tests/test/runs/query";

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

export function buildCommitRunsStatsQuery(
  query: Pick<CommitRunsListQuery, "repo" | "sha">
) {
  return buildRunStatsQuery(commitRunsScope(query));
}

function commitRunsScope(query: Pick<CommitRunsListQuery, "repo" | "sha">) {
  return {
    params: { sha: query.sha, repo: query.repo },
    // Workflow IDs and their job associations are immutable; IN also removes
    // duplicate metadata rows. Match workflow.head_sha, since a PR job's SHA
    // can instead identify its merge commit. Include every workflow attempt.
    // A scalar subquery is cached for this query. A named table CTE would
    // repeat the workflow/job scan for each reference in the run query and
    // its metadata filters. Every request still discovers current membership.
    prefix: `
WITH (
    SELECT groupArray(id)
    FROM default.workflow_job
    WHERE run_id IN (
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
