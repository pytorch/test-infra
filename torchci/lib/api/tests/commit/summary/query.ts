import { commitRunsScope } from "lib/api/tests/commit/query";
import type { CommitSummaryQuery } from "lib/api/tests/commit/summary/parameters";
import { CI_DATABASE } from "lib/api/tests/database";
import {
  BUNDLE_STATUS_SQL,
  classifiedRunsSource,
  RUN_GROUP_FIELDS,
  withClause,
} from "lib/api/tests/test/runs/query";
import { BUNDLE_STATUSES, BundleStatus } from "lib/runOutcomes";

// The commit's workflow runs and pushes, as GitHub described them: how many,
// the commit's message, author and timestamp, the branches of its push runs
// (a ciflow tag's push is a pull request's, not a branch's), the pull
// requests its runs record whose base repository is its own, the head branch
// of its pull_request runs, and from the push the author's login and the
// refs. The workflow runs are read by id through the head_sha view and the
// pushes by the push table's timestamp key, found through
// materialized_views.push_by_sha (ordered by commit id), whose view records
// every push's commit id and timestamp: on 2026-11-03 it held all 1,876,574
// pushes with a head commit. A scan of the push table's head commit id read
// 2.6 million rows (commit/query-validation.md, 2026-11-03).
export function buildCommitInfoQuery(query: CommitSummaryQuery) {
  // Tuple positions of a zipped pull request: number, API url and base
  // repository id; of a gathered one: number and API url.
  return {
    params: { sha: query.sha, repo: query.repo },
    sql: `
WITH
    (
        SELECT (
            count(),
            any(head_commit.message),
            any(head_commit.author.name),
            toUnixTimestamp64Milli(any(head_commit.timestamp)),
            groupUniqArrayIf(head_branch, event = 'push' AND NOT startsWith(head_branch, 'ciflow/')),
            groupUniqArrayArray(arrayMap(pull_request -> (tupleElement(pull_request, 1), tupleElement(pull_request, 2)), arrayFilter(pull_request -> tupleElement(pull_request, 3) = repository.id, arrayZip(pull_requests.number, pull_requests.url, pull_requests.base.repo.id)))),
            anyIf(head_branch, event = 'pull_request')
        )
        FROM default.workflow_run
        WHERE id IN (
            SELECT id
            FROM materialized_views.workflow_run_by_head_sha
            WHERE head_sha = {sha: String}
        )
            AND head_sha = {sha: String}
            AND repository.full_name = {repo: String}
    ) AS workflow,
    (
        SELECT (
            count(),
            any(head_commit.author.username),
            any(head_commit.message),
            any(head_commit.author.name),
            toUnixTimestamp64Milli(any(head_commit.timestamp)),
            groupUniqArray(ref)
        )
        FROM default.push
        WHERE tupleElement(head_commit, 'timestamp') IN (
            SELECT timestamp FROM materialized_views.push_by_sha WHERE id = {sha: String}
        )
            AND head_commit.id = {sha: String}
            AND repository.full_name = {repo: String}
    ) AS push
SELECT
    tupleElement(workflow, 1) AS workflow_runs,
    tupleElement(workflow, 2) AS workflow_message,
    tupleElement(workflow, 3) AS workflow_author_name,
    tupleElement(workflow, 4) AS workflow_committed_at_ms,
    tupleElement(workflow, 5) AS push_branches,
    tupleElement(workflow, 6) AS pull_requests,
    tupleElement(workflow, 7) AS pull_request_branch,
    tupleElement(push, 1) AS pushes,
    tupleElement(push, 2) AS author_login,
    tupleElement(push, 3) AS push_message,
    tupleElement(push, 4) AS push_author_name,
    tupleElement(push, 5) AS push_committed_at_ms,
    tupleElement(push, 6) AS refs
`,
  };
}

// A pull request's title and page, from its latest retained record. The
// table holds every repository's pull requests under their own numbers, so
// the base repository picks the commit's.
export function buildCommitPullRequestQuery(number: number, repo: string) {
  return {
    params: { number, repo },
    sql: `
SELECT title, html_url
FROM default.pull_request
WHERE number = {number: Int64}
    AND base.repo.full_name = {repo: String}
ORDER BY updated_at DESC
LIMIT 1
`,
  };
}

// The pull request a commit is or was the head of, for a commit whose
// workflow runs record none: every run of a pull request from a fork records
// none, its ciflow tag push's run included (2026-11-02: 333 of 333 fork heads
// of two days, where every head in the repository was recorded). The
// pull requests whose head the commit has been come from
// materialized_views.pr_by_sha, which is ordered by head_sha; of their
// records in the commit's repository, read by number, the lowest numbered
// pull request's latest: its title, page and head branch. One row or none.
export function buildCommitPullRequestByHeadQuery({
  sha,
  repo,
}: {
  sha: string;
  repo: string;
}) {
  return {
    params: { sha, repo },
    sql: `
SELECT number, title, html_url, head.ref AS head_branch
FROM default.pull_request
WHERE number IN (
    SELECT number
    FROM materialized_views.pr_by_sha
    WHERE head_sha = {sha: String}
)
    AND base.repo.full_name = {repo: String}
ORDER BY number ASC, updated_at DESC
LIMIT 1
`,
  };
}

// The nearest commits pushed to the branch before and after the commit, by
// the push's commit timestamp, that have a test job among their workflow
// jobs: the newest of those before and the oldest after. Twenty candidates
// a side come from the push table, gathered once into an array scalar, as
// the commit's jobs are (commitRunsScope), since a named subquery runs
// again at every reference. Each side reads the push table in its key
// order, the commit timestamp spelled as the key is,
// tupleElement(head_commit, 'timestamp'), which the dotted form neither
// prunes nor orders by, and stops at its twentieth push: the older side,
// which read the timestamp of every push, 2.6 million rows, until
// 2026-11-03, reads some 140 thousand on main, and every push only on a
// branch with fewer than twenty older ones (commit/query-validation.md,
// 2026-11-03). The candidates' jobs come
// through the head_sha view of the job table and are read by id, the jobs
// with a test name give their workflow runs, and the runs are read by id
// and matched to the candidates by head_sha; a scan of the job table for
// test jobs read 139 million rows. On a push run a job's head_sha is its
// run's (111,248 of 111,248 test jobs of the week before 2026-11-01), so
// the candidates with a test job are the ones the runs name.
export const NEIGHBOUR_CANDIDATES = 20;

export function buildCommitNeighboursQuery({
  repo,
  branch,
  committedAtMs,
}: {
  repo: string;
  branch: string;
  committedAtMs: number;
}) {
  // Tuple positions of a candidate: its direction, SHA and commit time.
  const CANDIDATE_DIRECTION = "tupleElement(candidate, 1)";
  const CANDIDATE_SHA = "tupleElement(candidate, 2)";
  const CANDIDATE_COMMITTED_AT = "tupleElement(candidate, 3)";
  // The push table's sort key leads with the commit timestamp, spelled here
  // as the key spells it.
  const timestamp = "tupleElement(head_commit, 'timestamp')";
  const candidates = (direction: "newer" | "older") => `
        SELECT '${direction}' AS direction, head_commit.id AS sha, head_commit.timestamp AS committed_at
        FROM default.push
        WHERE ref = {ref: String}
            AND repository.full_name = {repo: String}
            AND ${timestamp} ${
    direction === "newer" ? ">" : "<"
  } fromUnixTimestamp64Milli({committed_at_ms: Int64})
        ORDER BY ${timestamp} ${direction === "newer" ? "ASC" : "DESC"}
        LIMIT ${NEIGHBOUR_CANDIDATES}`;
  return {
    params: {
      repo,
      ref: `refs/heads/${branch}`,
      committed_at_ms: committedAtMs,
    },
    sql: `
WITH (
    SELECT groupArray((direction, sha, committed_at))
    FROM (${candidates("newer")}
        UNION ALL${candidates("older")}
    )
) AS candidates
SELECT
    ${CANDIDATE_DIRECTION} AS direction,
    ${
      // The oldest newer commit and the newest older one.
      ""
    }if(direction = 'newer', argMin(${CANDIDATE_SHA}, ${CANDIDATE_COMMITTED_AT}), argMax(${CANDIDATE_SHA}, ${CANDIDATE_COMMITTED_AT})) AS neighbour
FROM (SELECT arrayJoin(candidates) AS candidate)
WHERE ${CANDIDATE_SHA} IN (
    SELECT head_sha
    FROM default.workflow_run
    WHERE id IN (
        SELECT run_id
        FROM default.workflow_job
        WHERE id IN (
            SELECT id
            FROM materialized_views.workflow_job_by_head_sha
            WHERE head_sha IN (SELECT ${CANDIDATE_SHA} FROM (SELECT arrayJoin(candidates) AS candidate))
        )
            AND name LIKE '% / test (%'
    )
        AND repository.full_name = {repo: String}
)
GROUP BY direction
ORDER BY direction
`,
  };
}

// A status's rank, its place in BUNDLE_STATUSES counted from 1: failed is 1
// and skipped 7, so a test's worst status is its bundles' least rank. The
// counts carry ranks rather than status words, a UInt8 a bundle instead of a
// string to compare at every step.
function statusRank(status: BundleStatus) {
  return BUNDLE_STATUSES.indexOf(status) + 1;
}

const BUNDLE_STATUSES_SQL = `[${BUNDLE_STATUSES.map(
  (status) => `'${status}'`
).join(", ")}]`;

// The rank of a bundle holding one attempt, from that attempt's outcome:
// BUNDLE_STATUS_SQL on one row, ranked.
function singleAttemptRankSql(outcome: string) {
  return `toUInt8(multiIf(${outcome} = 'skipped', ${statusRank(
    "skipped"
  )}, ${outcome} IN ('failed', 'error', 'crashed'), ${statusRank(
    "failed"
  )}, ${outcome} = 'timed_out', ${statusRank(
    "timed_out"
  )}, ${outcome} = 'passed', ${statusRank(
    "passed"
  )}, ${outcome} = 'xfailed', ${statusRank("xfailed")}, ${statusRank(
    "other"
  )}))`;
}

// The rank of a bundle of grouped attempts: BUNDLE_STATUS_SQL, ranked.
const BUNDLE_RANK_SQL = `toUInt8(indexOf(${BUNDLE_STATUSES_SQL}, ${BUNDLE_STATUS_SQL}))`;

// The counts over a source of bundles, each row one bundle's test, job,
// rank, start and end. Each test's bundles are gathered into two parallel
// arrays, their jobs and their ranks (one aggregation fills both, so the
// positions agree), beside the test's worst rank, the set of ranks it holds
// as bits and the span of its runs; the arrays are then unfolded back into
// one row a bundle, the test's own columns beside it and its first bundle
// marked, and counted per worst status: the tests (first bundles) and the
// distinct jobs of the bundles of their worst status, and for each status the
// tests holding it, the distinct jobs and the number of its bundles. The
// rollup row (category '') counts the whole commit, the only row whose
// per-status figures the summary reads. One aggregation over the unfolded
// bundles replaced (2026-11-05) an array of (job, status word) pairs that
// each test's row read some 25 times with string comparisons: a quarter less
// time on one thread on a main commit (query-validation.md, 2026-11-05).
function commitTestCountsSql(bundles: string) {
  return `SELECT
    ${BUNDLE_STATUSES_SQL}[worst_rank] AS category,
    countIf(bundle_index = 1) AS tests,
    uniqExactIf(job_id, rank = worst_rank) AS jobs,
    ${BUNDLE_STATUSES.map(
      (status) =>
        `countIf(bundle_index = 1 AND bitTest(rank_bits, ${statusRank(
          status
        )})) AS ${status}_tests,
    uniqExactIf(job_id, rank = ${statusRank(
      status
    )}) AS ${status}_distinct_jobs,
    countIf(rank = ${statusRank(status)}) AS ${status}_bundles`
    ).join(",\n    ")},
    uniqExact(job_id) AS any_jobs,
    min(first_started_at) AS first_started_at,
    max(last_ended_at) AS last_ended_at
FROM (
    SELECT
        tests_id,
        groupArray(job_id) AS job_ids,
        groupArray(rank) AS ranks,
        min(rank) AS worst_rank,
        groupBitOr(bitShiftLeft(toUInt8(1), rank)) AS rank_bits,
        min(started_at) AS first_started_at,
        max(ended_at) AS last_ended_at
    FROM (${bundles}
    )
    GROUP BY tests_id
)
ARRAY JOIN job_ids AS job_id, ranks AS rank, arrayEnumerate(job_ids) AS bundle_index
GROUP BY category WITH ROLLUP
SETTINGS optimize_move_to_prewhere_if_final = 0
`;
}

// The commit's test counts, read as the statistics read the commit: one
// by_job pass groups the commit's stored rows by job and test and keeps the
// keys holding more than one row; every other key is a one-attempt bundle in
// its only version, whose status is its outcome's, read straight off by_job;
// and the other keys' rows, pruned by key on by_job, are read as FINAL would
// return them and grouped into bundles. The keys partition the rows, so no
// bundle is counted twice. The evidence compares it with the counts query it
// replaced, which had been recorded equal to a read of every row through
// FINAL (summary-query-validation.json).
//
// The (job, test) key sets hold the test through identity(), which index
// analysis does not look into. The runs table's primary key leads with the
// test, so a set naming some 3,800 tests made ClickHouse search the main
// table's index, every part and some 1.9 million marks, before it chose
// by_job for the read, which the job prunes: about a second for each read
// holding the set, with the same rows read (2026-11-05). by_job still prunes
// by the key's job.
export function buildCommitTestCountsQuery(query: CommitSummaryQuery) {
  const scope = commitRunsScope(query);
  const where = `WHERE ${scope.filters.join("\n            AND ")}`;
  const jobTest = "(run.github_workflow_job_id, identity(run.tests_id))";
  const multiRowWhere = `${where}
            AND ${jobTest} IN (SELECT arrayJoin(multi_row_keys))`;
  return {
    params: { ...scope.params },
    sql: `${withClause(scope)}
(
    SELECT groupArray(job_test)
    FROM (
        SELECT (run.github_workflow_job_id, run.tests_id) AS job_test
        FROM ${CI_DATABASE}.runs AS run
        ${where}
        GROUP BY run.github_workflow_job_id, run.tests_id
        HAVING count() > 1
    )
) AS multi_row_keys
${commitTestCountsSql(`
        SELECT run.tests_id AS tests_id,
            run.github_workflow_job_id AS job_id,
            ${singleAttemptRankSql("run.outcome")} AS rank,
            run.started_at AS started_at,
            run.ended_at AS ended_at
        FROM ${CI_DATABASE}.runs AS run
        ${where}
            AND ${jobTest} NOT IN (SELECT arrayJoin(multi_row_keys))
        UNION ALL
        SELECT run.tests_id AS tests_id,
            run.github_workflow_job_id AS job_id,
            ${BUNDLE_RANK_SQL} AS rank,
            min(run.started_at) AS started_at,
            max(run.ended_at) AS ended_at
        FROM ${classifiedRunsSource(multiRowWhere, [
          "started_at",
          "ended_at",
          "id",
          "outcome",
        ])}
        GROUP BY ${RUN_GROUP_FIELDS.map((field) => `run.${field}`).join(
          ", "
        )}`)}`,
  };
}
