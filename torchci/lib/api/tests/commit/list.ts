import type { ListPageData } from "lib/api/schema";
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
  // The statistics group the commit's rows through by_job in a few CPU
  // seconds at most, under the heavy bar, so they stay out of the queue.
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
}): Promise<ListPageData<CommitRunListPage>> {
  const [page, statistics] = await Promise.all([
    queryRunsPage({
      build: (cursor, limit) =>
        buildCommitRunsQuery({ ...query, limit }, cursor),
      cursor,
      limit: query.limit,
      keys: runSortKeys(query, true),
      queryId: "api_commit_runs_page",
      // The page and its probe stay out of the heavy workload: a typical
      // commit page costs a couple of CPU-seconds, and only a big commit's
      // reaches the bar (app/api/README.md, Heavy queries).
      createCursor: (values, direction): CommitRunsCursor => ({
        version: 2,
        resource: "commit-runs",
        direction,
        query: commitRunsIdentity(query),
        position: { values },
      }),
      encodeCursor: encodeCommitRunsCursor,
    }),
    commitRunsStats({ repo: query.repo, sha: query.sha }),
  ]);
  return {
    ...page,
    stats: statistics.stats,
    query_duration_ms: page.query_duration_ms + statistics.query_duration_ms,
  };
}
