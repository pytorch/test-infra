import {
  BUNDLE_RANK_SQL,
  singleAttemptRankSql,
  statusRank,
} from "lib/api/tests/commit/summary/query";
import { CI_DATABASE } from "lib/api/tests/database";
import {
  classifiedRunsSource,
  RUN_GROUP_FIELDS,
  RunPageScope,
  withClause,
} from "lib/api/tests/test/runs/query";
import {
  WORKFLOW_JOB_ORDER_SQL,
  WORKFLOW_RUN_ORDER_SQL,
} from "lib/api/tests/test/runs/workflow-query";
import { BUNDLE_STATUSES, FAILING_OUTCOMES } from "lib/runOutcomes";

// A job as GitHub describes it, with its workflow run: the latest retained
// row of each, as the run lists read them. Times are Unix milliseconds, 0
// for a time GitHub has not set.
function jobsSql(jobs: string, workflowRuns: string, join: string) {
  return `
SELECT
    toString(job.id) AS id,
    job.name AS name,
    job.html_url AS url,
    job.status AS status,
    job.conclusion AS conclusion,
    toUnixTimestamp64Milli(job.created_at) AS created_at_ms,
    toUnixTimestamp64Milli(job.started_at) AS started_at_ms,
    toUnixTimestamp64Milli(job.completed_at) AS completed_at_ms,
    job.labels AS labels,
    job.step_names AS step_names,
    job.step_conclusions AS step_conclusions,
    arrayMap(moment -> toUnixTimestamp64Milli(moment), job.step_started_at) AS step_started_at_ms,
    arrayMap(moment -> toUnixTimestamp64Milli(moment), job.step_completed_at) AS step_completed_at_ms,
    job.failure_line AS failure_line,
    toString(job.run_id) AS workflow_run_id,
    job.run_attempt AS workflow_run_attempt,
    workflow.name AS workflow_name,
    workflow.path AS workflow_path,
    workflow.event AS workflow_event,
    workflow.head_sha AS head_sha,
    workflow.repo AS repo
FROM (
    SELECT id, run_id, run_attempt, name, html_url, status, conclusion, created_at, started_at, completed_at, labels,
        steps.name AS step_names,
        steps.conclusion AS step_conclusions,
        steps.started_at AS step_started_at,
        steps.completed_at AS step_completed_at,
        torchci_classification.line AS failure_line
    FROM default.workflow_job FINAL
    WHERE ${jobs}
    ORDER BY ${WORKFLOW_JOB_ORDER_SQL}
    LIMIT 1 BY id
) AS job
${join} JOIN (
    SELECT id, name, path, event, head_sha, repository.full_name AS repo
    FROM default.workflow_run FINAL
    WHERE ${workflowRuns}
    ORDER BY ${WORKFLOW_RUN_ORDER_SQL}
    LIMIT 1 BY id
) AS workflow ON workflow.id = job.run_id
ORDER BY job.id
`;
}

// Every job of the commit: the jobs GitHub recorded for the SHA, of the
// commit's workflow runs in the repository, which is the membership the
// commit's runs use (commitRunsScope).
export function buildCommitJobsQuery(query: { sha: string; repo: string }) {
  return {
    params: { sha: query.sha, repo: query.repo },
    sql: jobsSql(
      `id IN (
        SELECT id
        FROM materialized_views.workflow_job_by_head_sha
        WHERE head_sha = {sha: String}
    )`,
      `id IN (
        SELECT id
        FROM materialized_views.workflow_run_by_head_sha
        WHERE head_sha = {sha: String}
    )
        AND head_sha = {sha: String}
        AND repository.full_name = {repo: String}`,
      "INNER"
    ),
  };
}

// One job, with its workflow run when HUD has it.
export function buildJobQuery(jobId: string) {
  return {
    params: { job_id: jobId },
    sql: jobsSql(
      "id = {job_id: Int64}",
      `id IN (
        SELECT run_id
        FROM default.workflow_job
        WHERE id = {job_id: Int64}
    )`,
      "LEFT"
    ),
  };
}

// The timeline's resolution: a recorded test covers the 5-second slots it
// ran in. An attempt is read as a day long at most, so that a bad end time
// cannot ask for an unbounded range.
export const TEST_SLOT_SECONDS = 5;
const MAX_ATTEMPT_SLOTS = (24 * 60 * 60) / TEST_SLOT_SECONDS;

const FAILING_OUTCOMES_SQL = `(${[...FAILING_OUTCOMES]
  .map((outcome) => `'${outcome}'`)
  .join(", ")})`;
const FIRST_SLOT_SQL = `toUInt32(intDiv(toUnixTimestamp(run.started_at), ${TEST_SLOT_SECONDS}))`;
const LAST_SLOT_SQL = `least(greatest(toUInt32(intDiv(toUnixTimestamp(run.ended_at), ${TEST_SLOT_SECONDS})), ${FIRST_SLOT_SQL}), ${FIRST_SLOT_SQL} + ${MAX_ATTEMPT_SLOTS})`;

// What the tests of each job in the scope did: its bundles by status, the
// slots in which an executed attempt was running, folded into stretches
// (the first and last slot of each), and how many attempts failed, apart
// for the bundles that ended failed or timed out and for the rest, which
// passed on a rerun. The rows are read as the summary's counts
// read them (buildCommitTestCountsQuery): a job and test key holding one
// stored row is a one-attempt bundle, read straight off by_job, and carries
// its slots as two numbers; the other keys' rows are read as FINAL would
// return them and grouped into bundles. A stretch begins at a slot that does
// not follow the one before it and ends at a slot the next does not follow:
// the gaps between neighbours say which, 0 standing for no neighbour. A
// lambda that looks the neighbour up in the array has the array copied for
// each of its slots, which took most of the query's time and memory.
export function buildJobTestsQuery(
  scope: Pick<RunPageScope, "params" | "filters" | "prefix">
) {
  const where = `WHERE ${scope.filters.join("\n            AND ")}`;
  const jobTest = "(run.github_workflow_job_id, identity(run.tests_id))";
  const multiRowWhere = `${where}
            AND ${jobTest} IN (SELECT arrayJoin(multi_row_keys))`;
  const endedBadly = `rank <= ${statusRank("timed_out")}`;
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
SELECT
    job_id,
    ${BUNDLE_STATUSES.join(", ")},
    arrayFilter((slot, gap) -> gap != 1, covered, arrayDifference(covered)) AS stretch_first_slots,
    arrayFilter((slot, gap) -> gap != 1, covered, arrayPopFront(arrayPushBack(arrayDifference(covered), 0))) AS stretch_last_slots,
    failed_attempts,
    flaky_attempts
FROM (
    SELECT
        toString(job_id) AS job_id,
        ${BUNDLE_STATUSES.map(
          (status) => `countIf(rank = ${statusRank(status)}) AS ${status}`
        ).join(",\n        ")},
        arraySort(arrayDistinct(arrayConcat(
            groupUniqArrayIf(first_slot, first_slot != 0),
            groupUniqArrayArrayIf(range(first_slot + 1, last_slot + 1), last_slot > first_slot),
            groupUniqArrayArray(slots)
        ))) AS covered,
        sumIf(failing_attempts, ${endedBadly}) AS failed_attempts,
        sumIf(failing_attempts, NOT ${endedBadly}) AS flaky_attempts
    FROM (
        SELECT run.github_workflow_job_id AS job_id,
            ${singleAttemptRankSql("run.outcome")} AS rank,
            if(run.outcome != 'skipped', ${FIRST_SLOT_SQL}, 0) AS first_slot,
            if(run.outcome != 'skipped', ${LAST_SLOT_SQL}, 0) AS last_slot,
            CAST([], 'Array(UInt32)') AS slots,
            toUInt64(run.outcome IN ${FAILING_OUTCOMES_SQL}) AS failing_attempts
        FROM ${CI_DATABASE}.runs AS run
        ${where}
            AND ${jobTest} NOT IN (SELECT arrayJoin(multi_row_keys))
        UNION ALL
        SELECT run.github_workflow_job_id AS job_id,
            ${BUNDLE_RANK_SQL} AS rank,
            toUInt32(0) AS first_slot,
            toUInt32(0) AS last_slot,
            groupArrayArrayIf(range(${FIRST_SLOT_SQL}, ${LAST_SLOT_SQL} + 1), run.outcome != 'skipped') AS slots,
            countIf(run.outcome IN ${FAILING_OUTCOMES_SQL}) AS failing_attempts
        FROM ${classifiedRunsSource(multiRowWhere, [
          "started_at",
          "ended_at",
          "id",
          "outcome",
        ])}
        GROUP BY ${RUN_GROUP_FIELDS.map((field) => `run.${field}`).join(", ")}
    )
    GROUP BY job_id
)
ORDER BY job_id
SETTINGS optimize_move_to_prewhere_if_final = 0
`,
  };
}
