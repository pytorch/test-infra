import type { ListPageData } from "lib/api/schema";
import {
  CommitRunsCursor,
  commitRunsIdentity,
  encodeCommitRunsCursor,
} from "lib/api/tests/commit/cursor";
import { CommitRunsListQuery } from "lib/api/tests/commit/parameters";
import { buildCommitRunsQuery } from "lib/api/tests/commit/query";
import { CommitRunListPage } from "lib/api/tests/commit/types";
import { commitPageUrl } from "lib/api/tests/pages/links";
import { queryRunsPage } from "lib/api/tests/test/runs/list";
import { runSortKeys } from "lib/api/tests/test/runs/query";

export async function listCommitRuns({
  query,
  cursor,
}: {
  query: CommitRunsListQuery;
  cursor: CommitRunsCursor | null;
}): Promise<ListPageData<CommitRunListPage>> {
  const page = await queryRunsPage({
    build: (cursor, limit) => buildCommitRunsQuery({ ...query, limit }, cursor),
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
  });
  return { ...page, hud_url: commitPageUrl(query.repo, query.sha) };
}
