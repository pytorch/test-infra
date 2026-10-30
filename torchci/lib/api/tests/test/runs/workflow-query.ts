// The latest retained metadata row of a job and of a workflow run, for every
// read that picks one: the bundle pages here and the grid (grid-query.ts).
export const WORKFLOW_JOB_ORDER_SQL =
  "_inserted_at DESC, run_id DESC, dynamoKey DESC";
export const WORKFLOW_RUN_ORDER_SQL =
  "_inserted_at DESC, run_attempt DESC, dynamoKey DESC";

// The path workflow_path filters and sorting compare, and enrichment returns.
export const WORKFLOW_PATH_SQL = "nullIf(workflow.path, '')";

// Latest retained metadata for a set of jobs. Page selection (workflow_path
// filters and sorting) and page enrichment both read it here, so a run is
// filtered and sorted by the same metadata row it returns.
// FINAL still retains distinct dynamoKeys, so select one row per GitHub ID.
// Workflow attempts share a run ID, and newer attempts can replace earlier
// metadata. The retained workflow row describes the run for every attempt.
// Workflow IDs come from a plain read of the requested jobs, not from `jobs`:
// every reference to a CTE executes it again, FINAL included. The plain read
// yields every stored run ID of these jobs, a superset of the selected rows'
// IDs; a workflow outside that selection matches no job in the join.
export function workflowMetadataSql({
  jobIds,
  jobColumns,
  workflowColumns,
  columns,
}: {
  // A parenthesized subquery or array expression of workflow job IDs.
  jobIds: string;
  // Read in addition to id and run_id from workflow_job, id from workflow_run.
  jobColumns: string[];
  workflowColumns: string[];
  // The result columns, over the `job` and `workflow` rows.
  columns: string[];
}) {
  return `WITH jobs AS (
    SELECT ${["id", "run_id", ...jobColumns].join(", ")}
    FROM default.workflow_job FINAL
    WHERE id IN ${jobIds}
    ORDER BY ${WORKFLOW_JOB_ORDER_SQL}
    LIMIT 1 BY id
)
SELECT
    ${columns.join(",\n    ")}
FROM jobs AS job
LEFT JOIN (
    SELECT ${["id", ...workflowColumns].join(", ")}
    FROM default.workflow_run FINAL
    WHERE id IN (
        SELECT run_id FROM default.workflow_job
        WHERE id IN ${jobIds}
    )
    ORDER BY ${WORKFLOW_RUN_ORDER_SQL}
    LIMIT 1 BY id
) AS workflow ON workflow.id = job.run_id`;
}

export function buildRunWorkflowQuery(jobIds: string[]) {
  // Enrich only the returned page. Both tables are indexed by ID; restricting
  // workflow IDs to these jobs avoids scanning unrelated workflow metadata.
  const sql = workflowMetadataSql({
    jobIds: "CAST({github_workflow_job_ids: Array(String)}, 'Array(Int64)')",
    jobColumns: ["html_url", "name"],
    workflowColumns: [
      "path",
      "head_sha",
      "event",
      "repository.id AS repository_id",
      "pull_requests.number AS pull_request_numbers",
      "pull_requests.url AS pull_request_urls",
      "pull_requests.base.repo.id AS pull_request_base_repository_ids",
    ],
    columns: [
      "toString(job.id) AS github_workflow_job_id",
      "nullIf(toString(job.run_id), '0') AS github_workflow_run_id",
      `${WORKFLOW_PATH_SQL} AS workflow_path`,
      "nullIf(workflow.head_sha, '') AS commit_sha",
      "nullIf(job.html_url, '') AS github_workflow_job_url",
      "nullIf(job.name, '') AS github_workflow_job_name",
      "nullIf(workflow.event, '') AS workflow_event",
      "workflow.id != 0 AS workflow_metadata_available",
      "nullIf(toString(workflow.repository_id), '0') AS workflow_repository_id",
      // Keep repository IDs lossless so the mapper can retain only PRs whose
      // destination repository matches the workflow repository. A push can
      // have associations with PRs targeting unrelated forks.
      "CAST(arrayZip(workflow.pull_request_numbers, workflow.pull_request_urls, workflow.pull_request_base_repository_ids), 'Array(Tuple(number Int64, url String, base_repository_id String))') AS workflow_pull_requests",
    ],
  });
  return {
    params: { github_workflow_job_ids: Array.from(new Set(jobIds)) },
    // The mapper expects named PR tuples as objects, independent of the
    // server or client serialization default.
    sql: `\n${sql}\nSETTINGS output_format_json_named_tuples_as_objects = 1\n`,
  };
}
