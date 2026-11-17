import {
  BUNDLE_RANK_SQL,
  statusRank,
} from "lib/api/tests/commit/summary/query";
import { CI_DATABASE } from "lib/api/tests/database";
import {
  classifiedRunsSource,
  RUN_GROUP_FIELDS,
  RunPageScope,
} from "lib/api/tests/test/runs/query";
import { BUNDLE_STATUSES, FAILING_OUTCOMES } from "lib/runOutcomes";

// The runs of one job: by_job prunes the read to them.
export function jobRunsScope(
  jobId: string
): Pick<RunPageScope, "params" | "filters"> {
  return {
    params: { job_id: jobId },
    filters: ["run.github_workflow_job_id = {job_id: Int64}"],
  };
}

const FAILING_OUTCOMES_SQL = `(${[...FAILING_OUTCOMES]
  .map((outcome) => `'${outcome}'`)
  .join(", ")})`;

// The job's test files, one row per file and report, a report being one
// launch of a test file in its own process: when its attempts started and
// ended, how many executed, how many failed (apart for the bundles that
// ended failed or timed out and for the rest), and the bundles by status,
// each bundle counted in the report of its first attempt. The rows are read
// as FINAL would return them. Tuple positions of an attempt: its report,
// start, end and outcome.
export function buildJobFilesQuery(jobId: string) {
  const scope = jobRunsScope(jobId);
  const where = `WHERE ${scope.filters.join("\n            AND ")}`;
  const failing = `outcome IN ${FAILING_OUTCOMES_SQL}`;
  const endedBadly = `rank <= ${statusRank("timed_out")}`;
  return {
    params: { ...scope.params },
    sql: `
SELECT
    test.file AS file,
    toString(report) AS report,
    min(started_at) AS first_started_at,
    max(ended_at) AS last_ended_at,
    countIf(outcome != 'skipped') AS executed_attempts,
    countIf(${failing} AND ${endedBadly}) AS failed_attempts,
    countIf(${failing} AND NOT ${endedBadly}) AS flaky_attempts,
    ${BUNDLE_STATUSES.map(
      (status) =>
        `countIf(attempt_number = 1 AND rank = ${statusRank(
          status
        )}) AS ${status}`
    ).join(",\n    ")}
FROM (
    SELECT
        tests_id,
        rank,
        tupleElement(attempt, 1) AS report,
        tupleElement(attempt, 2) AS started_at,
        tupleElement(attempt, 3) AS ended_at,
        tupleElement(attempt, 4) AS outcome,
        attempt_number
    FROM (
        SELECT run.tests_id AS tests_id,
            ${BUNDLE_RANK_SQL} AS rank,
            arraySort(
                attempt -> (tupleElement(attempt, 2), tupleElement(attempt, 3)),
                groupArray((run.report_uuid, run.started_at, run.ended_at, toString(run.outcome)))
            ) AS attempts
        FROM ${classifiedRunsSource(where, [
          "started_at",
          "ended_at",
          "id",
          "outcome",
          "report_uuid",
        ])}
        GROUP BY ${RUN_GROUP_FIELDS.map((field) => `run.${field}`).join(", ")}
    )
    ARRAY JOIN attempts AS attempt, arrayEnumerate(attempts) AS attempt_number
) AS attempt
LEFT JOIN (
    SELECT id, file
    FROM ${CI_DATABASE}.tests FINAL
    WHERE id IN (
        SELECT run.tests_id
        FROM ${CI_DATABASE}.runs AS run
        ${where}
    )
) AS test ON test.id = attempt.tests_id
GROUP BY file, report
ORDER BY first_started_at, file, report
SETTINGS optimize_move_to_prewhere_if_final = 0
`,
  };
}
