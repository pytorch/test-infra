import { pullPageUrl } from "lib/api/tests/pages/links";
import type { PullRequestQuery } from "lib/api/tests/pull/parameters";
import {
  buildPullRequestHeadRunsQuery,
  buildPullRequestRecordQuery,
} from "lib/api/tests/pull/query";
import type { PullRequestHead } from "lib/api/tests/pull/types";
import { timed } from "lib/api/tests/timed";
import { queryClickhouse } from "lib/clickhouse";

// The pull request's latest retained record.
export interface PullRequestRecordRow {
  head_sha: string;
  head_repo: string;
  head_branch: string;
  title: string;
  html_url: string;
}

// One head the pull request's records have named, on one head repository
// and branch, with the id of its newest pull_request run there.
export interface HeadRunRow {
  head_sha: string;
  head_repo: string;
  head_branch: string;
  newest_run_id: number;
}

// The pull request's newest head: the record's, unless the record fell
// behind. The pull_request table keeps the last row written for a pull
// request, and a row written just after a push sometimes still names the
// head before it while the push's own row, written first, is replaced
// (2026-11-05: 4 of the 1,500 most recently updated pytorch/pytorch pull
// requests, one a day behind; pr_by_sha still held every new head). Runs
// are created as heads are pushed, a push back to an earlier head and a
// push waiting for a maintainer's approval (action_required) included, so
// when the record's head ran a pull_request workflow on the pull request's
// branch, the head of the pull request whose run there is newest was
// pushed last. A recorded head that never ran one says nothing about the
// others' order, and the record stands: GitHub runs no pull_request
// workflow while a pull request has a merge conflict. That is also the one
// case answered wrong: a conflicting pull request pushed back to an earlier
// head that ran gets no new run, so the later head is answered. On that
// sample this matched GitHub's head for all 1,500, where the newest run
// alone missed 17, and it matched all 9 pushes back to an earlier head of
// the 60 days before (query-validation.md).
export function newestHead(
  record: PullRequestRecordRow,
  heads: readonly HeadRunRow[]
): string {
  const onBranch = heads.filter(
    (head) =>
      head.head_repo === record.head_repo &&
      head.head_branch === record.head_branch
  );
  if (!onBranch.some((head) => head.head_sha === record.head_sha)) {
    return record.head_sha;
  }
  return onBranch.reduce((newest, head) =>
    head.newest_run_id > newest.newest_run_id ? head : newest
  ).head_sha;
}

// The pull request and its newest head: null for a number HUD has no pull
// request record for in the repository. The two reads run concurrently;
// both are cheap (query-validation.md), so neither runs in the heavy
// workload.
export async function getPullRequestHead(
  query: PullRequestQuery
): Promise<PullRequestHead | null> {
  const recordQuery = buildPullRequestRecordQuery(query);
  const headsQuery = buildPullRequestHeadRunsQuery(query);
  const [record, heads] = await Promise.all([
    timed(
      queryClickhouse(
        recordQuery.sql,
        recordQuery.params,
        "api_pull_request_record"
      ) as Promise<PullRequestRecordRow[]>
    ),
    timed(
      queryClickhouse(
        headsQuery.sql,
        headsQuery.params,
        "api_pull_request_head_runs"
      ) as Promise<HeadRunRow[]>
    ),
  ]);
  const row = record.result[0];
  if (row === undefined) return null;
  return {
    number: query.number,
    title: row.title,
    url:
      row.html_url || `https://github.com/${query.repo}/pull/${query.number}`,
    head_sha: newestHead(row, heads.result),
    hud_url: pullPageUrl(query.repo, query.number),
    query_duration_ms: record.duration_ms + heads.duration_ms,
  };
}
