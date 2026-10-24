import {
  CommitRunsCursor,
  commitRunsIdentity,
  encodeCommitRunsCursor,
} from "lib/api/tests/commit/cursor";
import { CommitRunsListQuery } from "lib/api/tests/commit/parameters";
import {
  buildCommitRunsQuery,
  buildCommitRunsStatsQuery,
} from "lib/api/tests/commit/query";
import { CommitRunListPage } from "lib/api/tests/commit/types";
import { queryRunsPage } from "lib/api/tests/test/runs/list";
import { runSortKeys } from "lib/api/tests/test/runs/query";
import { RunStatsSchema } from "lib/api/tests/test/runs/types";
import { queryClickhouse } from "lib/clickhouse";

async function commitRunsStats(
  query: Pick<CommitRunsListQuery, "repo" | "sha">
) {
  const { sql, params } = buildCommitRunsStatsQuery(query);
  const startedAt = performance.now();
  const rows = await queryClickhouse(sql, params, "api_commit_runs_stats");
  const queryDurationMs = Math.round(performance.now() - startedAt);
  // An aggregate returns one row even when nothing matches. A missing or
  // malformed statistic is a query failure, rather than an empty result.
  return {
    stats: RunStatsSchema.parse(rows[0]),
    query_duration_ms: queryDurationMs,
  };
}

export async function listCommitRuns({
  query,
  cursor,
}: {
  query: CommitRunsListQuery;
  cursor: CommitRunsCursor | null;
}): Promise<CommitRunListPage> {
  const { sql, params } = buildCommitRunsQuery(query, cursor);
  const [page, statistics] = await Promise.all([
    queryRunsPage({
      sql,
      params,
      limit: query.limit,
      keys: runSortKeys(query, true),
      queryId: "api_commit_runs_page",
      encodeCursor: (values) =>
        encodeCommitRunsCursor({
          version: 2,
          resource: "commit-runs",
          query: commitRunsIdentity(query),
          position: { values },
        }),
    }),
    commitRunsStats({ repo: query.repo, sha: query.sha }),
  ]);
  return {
    ...page,
    stats: statistics.stats,
    query_duration_ms: page.query_duration_ms + statistics.query_duration_ms,
  };
}
