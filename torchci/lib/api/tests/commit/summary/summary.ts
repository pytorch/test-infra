import type { CommitSummaryQuery } from "lib/api/tests/commit/summary/parameters";
import {
  buildCommitInfoQuery,
  buildCommitNeighboursQuery,
  buildCommitPullRequestByHeadQuery,
  buildCommitPullRequestQuery,
  buildCommitTestCountsQuery,
} from "lib/api/tests/commit/summary/query";
import {
  CommitRecord,
  CommitSummary,
  CommitTestCounts,
} from "lib/api/tests/commit/summary/types";
import { RUNS_RETENTION_DAYS } from "lib/api/tests/database";
import { commitPageUrl } from "lib/api/tests/pages/links";
import { timed } from "lib/api/tests/timed";
import { queryClickhouse } from "lib/clickhouse";
import { titleFirstLine, titleSuffix } from "lib/commitTitle";
import { BUNDLE_STATUSES, BundleStatus } from "lib/runOutcomes";

interface CommitInfoRow {
  workflow_runs: number;
  workflow_message: string;
  workflow_author_name: string;
  workflow_committed_at_ms: number;
  // The head branches of the commit's push runs, ciflow tags left out.
  push_branches: string[];
  // (number, API url) pairs.
  pull_requests: [number, string][];
  // The head branch of the commit's pull_request runs; empty without any.
  pull_request_branch: string;
  pushes: number;
  author_login: string;
  push_message: string;
  push_author_name: string;
  push_committed_at_ms: number;
  refs: string[];
}

interface PullRequestRow {
  title: string;
  html_url: string;
}

// A pull request found by the commit's SHA among the heads its records have
// named, with its head branch.
interface PullRequestByHeadRow extends PullRequestRow {
  number: number;
  head_branch: string;
}

interface NeighbourRow {
  direction: "newer" | "older";
  neighbour: string;
}

// One row per worst result, plus the rollup row (category '') for the whole
// commit; the per-status columns are read off the rollup row alone.
interface CountsRow {
  [column: string]: unknown;
  category: string;
  tests: number;
  jobs: number;
  any_jobs: number;
  first_started_at: string;
  last_ended_at: string;
}

// The branch to name among several a commit was pushed to: main, else the
// first by name, so the answer does not change from one request to the next.
function preferredBranch(branches: readonly string[]): string | undefined {
  return branches.includes("main") ? "main" : [...branches].sort()[0];
}

function toCounts(rows: CountsRow[]): CommitTestCounts {
  const total = rows.find((row) => row.category === "");
  const zero = { tests: 0, jobs: 0 };
  const byWorstStatus = Object.fromEntries(
    BUNDLE_STATUSES.map((status) => {
      const row = rows.find((candidate) => candidate.category === status);
      return [
        status,
        row === undefined ? zero : { tests: row.tests, jobs: row.jobs },
      ];
    })
  ) as CommitTestCounts["by_worst_status"];
  const byStatus = Object.fromEntries(
    BUNDLE_STATUSES.map((status) => [
      status,
      total === undefined
        ? { ...zero, runs: 0 }
        : {
            tests: Number(total[`${status}_tests`]),
            jobs: Number(total[`${status}_distinct_jobs`]),
            runs: Number(total[`${status}_bundles`]),
          },
    ])
  ) as CommitTestCounts["by_status"];
  return {
    total:
      total === undefined
        ? { ...zero, runs: 0 }
        : {
            tests: total.tests,
            jobs: total.any_jobs,
            // Every bundle has one status, so the statuses' bundles add up.
            runs: BUNDLE_STATUSES.reduce(
              (sum, status) => sum + byStatus[status].runs,
              0
            ),
          },
    by_worst_status: byWorstStatus,
    by_status: byStatus,
  };
}

// The pull request page for an API URL GitHub records on a workflow run,
// "https://api.github.com/repos/pytorch/pytorch/pulls/202376".
function pullRequestPage(repo: string, number: number, apiUrl: string) {
  const match =
    /^https:\/\/api\.github\.com\/repos\/([^/?#]+\/[^/?#]+)\/pulls\/(\d+)$/.exec(
      apiUrl
    );
  return `https://github.com/${
    match === null ? repo : match[1]
  }/pull/${number}`;
}

// The summary of a commit's tests: null for a commit GitHub never told HUD
// about, with no workflow run and no push. The counts read the runs table
// while the commit's own lookup runs; the pull request's record and a branch
// commit's neighbours follow the lookup, since they depend on it. A commit
// whose runs record no pull request and that no push run put on a branch is
// first looked up as a pull request head by its SHA
// (buildCommitPullRequestByHeadQuery), which is how a pull request from a
// fork is known. The counts query reads every run of the commit, about 5
// seconds on one thread for a main commit's 9 million runs since 2026-11-05
// (22 before; commit/query-validation.md), so it stays out of the heavy
// workload, whose bar is about ten CPU-seconds (the API README's "Heavy
// queries"): queued there, the page's header waited behind tests pages.
export async function getCommitSummary(
  query: CommitSummaryQuery
): Promise<CommitSummary | null> {
  const countsQuery = buildCommitTestCountsQuery(query);
  const counts = timed(
    queryClickhouse(
      countsQuery.sql,
      countsQuery.params,
      "api_commit_summary_counts"
    ) as Promise<CountsRow[]>
  );
  // Observed from the start, so a failure of the lookup below does not leave
  // the counts' failure unhandled; awaiting counts still throws it.
  counts.catch(() => undefined);
  const info = buildCommitInfoQuery(query);
  const lookup = await timed(
    queryClickhouse(
      info.sql,
      info.params,
      "api_commit_summary_info"
    ) as Promise<CommitInfoRow[]>
  );
  const row = lookup.result[0];
  if (row === undefined || (row.workflow_runs === 0 && row.pushes === 0)) {
    // Let the counts finish rather than leave the query running unobserved.
    await counts.catch(() => undefined);
    return null;
  }
  const fromWorkflow = row.workflow_runs > 0;
  const message = fromWorkflow ? row.workflow_message : row.push_message;
  const committedAtMs = fromWorkflow
    ? row.workflow_committed_at_ms
    : row.push_committed_at_ms;
  const authorName = fromWorkflow
    ? row.workflow_author_name
    : row.push_author_name;
  // The pull request the runs record for the commit, the lowest numbered
  // when they record several: a commit with one is a pull request head,
  // whether its branch was pushed to the repository, as ghstack pushes
  // gh/<user>/<n>/head, or to a fork.
  const recorded = [...row.pull_requests].sort(
    ([left], [right]) => left - right
  )[0];
  // The runs of a pull request from a fork record no pull request at all,
  // its ciflow tag push's included. A commit they record none for, and that
  // no push run put on a branch, is looked up by its SHA among the heads the
  // repository's pull request records have named; a commit with push runs
  // on a branch is a branch commit.
  let byHead: { result: PullRequestByHeadRow[]; duration_ms: number } | null =
    null;
  if (recorded === undefined && row.push_branches.length === 0) {
    const byHeadQuery = buildCommitPullRequestByHeadQuery(query);
    byHead = await timed(
      queryClickhouse(
        byHeadQuery.sql,
        byHeadQuery.params,
        "api_commit_summary_pull_request_by_head"
      ) as Promise<PullRequestByHeadRow[]>
    );
  }
  const byHeadRow = byHead?.result[0];
  const pullRequestHead = recorded !== undefined || byHeadRow !== undefined;
  // The branch: for a pull request head the head branch its pull_request
  // runs record, else the one its record names; else, and failing that, the
  // branch of its push runs, else a branch ref of its push.
  const pushedBranches = row.refs
    .filter((ref) => ref.startsWith("refs/heads/"))
    .map((ref) => ref.slice("refs/heads/".length));
  const branch =
    (pullRequestHead && row.pull_request_branch !== ""
      ? row.pull_request_branch
      : undefined) ??
    (byHeadRow !== undefined && byHeadRow.head_branch !== ""
      ? byHeadRow.head_branch
      : undefined) ??
    preferredBranch(row.push_branches) ??
    preferredBranch(pushedBranches) ??
    null;
  // The pull request: the runs' own, else the one the commit's SHA found,
  // else the one a branch commit's title names at its end.
  const titled = titleSuffix(titleFirstLine(message));
  const pullRequestNumber =
    recorded !== undefined
      ? recorded[0]
      : byHeadRow !== undefined
      ? byHeadRow.number
      : branch !== null && titled !== null
      ? titled.pullRequest
      : null;

  // The record by number, unless the lookup by SHA read it already.
  const pullRequestQuery =
    pullRequestNumber === null || byHeadRow !== undefined
      ? null
      : buildCommitPullRequestQuery(pullRequestNumber, query.repo);
  const neighboursQuery =
    pullRequestHead || branch === null
      ? null
      : buildCommitNeighboursQuery({ repo: query.repo, branch, committedAtMs });
  const [pullRequest, neighbours] = await Promise.all([
    pullRequestQuery === null
      ? null
      : timed(
          queryClickhouse(
            pullRequestQuery.sql,
            pullRequestQuery.params,
            "api_commit_summary_pull_request"
          ) as Promise<PullRequestRow[]>
        ),
    neighboursQuery === null
      ? null
      : timed(
          queryClickhouse(
            neighboursQuery.sql,
            neighboursQuery.params,
            "api_commit_summary_neighbours"
          ) as Promise<NeighbourRow[]>
        ),
  ]);
  const pullRequestRow: PullRequestRow | undefined =
    byHeadRow ?? pullRequest?.result[0];
  const pullRequestTitle = pullRequestRow?.title ?? null;
  const counted = await counts;

  const commit: CommitRecord = {
    sha: query.sha,
    url: `https://github.com/${query.repo}/commit/${query.sha}`,
    title:
      pullRequestHead && pullRequestTitle !== null
        ? pullRequestTitle
        : titleFirstLine(message),
    author: {
      name: authorName === "" ? null : authorName,
      login: row.author_login === "" ? null : row.author_login,
    },
    committed_at: new Date(committedAtMs).toISOString(),
    branch,
    pull_request_head: pullRequestHead,
    pull_request:
      pullRequestNumber === null
        ? null
        : {
            number: pullRequestNumber,
            url:
              pullRequestRow?.html_url ||
              pullRequestPage(
                query.repo,
                pullRequestNumber,
                recorded === undefined ? "" : recorded[1]
              ),
            title: pullRequestTitle,
          },
    newer_sha:
      neighbours?.result.find((candidate) => candidate.direction === "newer")
        ?.neighbour ?? null,
    older_sha:
      neighbours?.result.find((candidate) => candidate.direction === "older")
        ?.neighbour ?? null,
  };
  const total = counted.result.find((candidate) => candidate.category === "");
  return {
    commit,
    counts: toCounts(counted.result),
    first_started_at: total === undefined ? null : total.first_started_at,
    last_ended_at: total === undefined ? null : total.last_ended_at,
    retention_starts_at: new Date(
      Date.now() - RUNS_RETENTION_DAYS * 24 * 60 * 60 * 1000
    ).toISOString(),
    hud_url: commitPageUrl(query.repo, query.sha),
    query_duration_ms:
      lookup.duration_ms +
      counted.duration_ms +
      (byHead?.duration_ms ?? 0) +
      (pullRequest?.duration_ms ?? 0) +
      (neighbours?.duration_ms ?? 0),
  };
}

export type { BundleStatus };
