import { listErrorResponses } from "lib/api/handler";
import { ApiResource, jsonResponse } from "lib/api/schema";
import { runsListParameters } from "lib/api/tests/test/runs/parameters";
import {
  GithubWorkflowSchema,
  RunAttemptSchema,
  RunListPageSchema,
  RunRecordSchema,
  RunReportSchema,
} from "lib/api/tests/test/runs/types";

const runGroupingDescription =
  "One run record bundles all retained executions with the same test, environment, environment-variable set and GitHub workflow job ID. Its attempts array includes the initial execution and every subsequent execution, including intentional repetitions, ordered by started_at, ended_at and id ascending. Attempts may span reports and rerun_number may reset between reports. Bundles are formed before pagination and never split across pages.";
const runCatalogDescription =
  "Each attempt exposes its execution UUID as id, which can be passed as run_id to GET /api/tests/run/{run_id} to retrieve its full bundle. Each bundle includes shared test, environment, env_vars and owners in the same shapes as /api/tests. Catalog IDs appear as test.id, environment.id and env_vars.id. Missing catalog objects are null and owners is empty when no owners are known. Catalog details and owners reflect current data, not their historical state when the test ran.";
const runWorkflowDescription =
  "Each run includes an always-present github_workflow object with job_id, run_id, path, commit_sha, job_url and job_name. github_workflow.job_id is the job ID recorded on the test run. github_workflow.commit_sha is workflow_run.head_sha; github_workflow.job_url and github_workflow.job_name are the actual workflow_job.html_url and workflow_job.name for the job that produced the test run. Workflow path and SHA use the latest retained metadata for the workflow run, shared across its attempts. The job URL and name remain available when workflow run metadata is missing. Unavailable metadata fields are null, without removing the run from the page. The workflow_path filter and sort field apply to github_workflow.path.";
const runReportDescription =
  "Each attempt includes its id, report, rerun_number, outcome, outcome_summary, started_at and ended_at. Its report object contains uuid and s3_url, the HTTPS link to its source JSONL report in S3. The UUID is always present; s3_url is null when the report location cannot be determined from the available test and workflow metadata.";
const runOptionsDescription =
  "Optional test, owner, environment, environment-variable, workflow_path, outcome and rerun_number filters select bundles before pagination. Exact, case-sensitive filters match any repeated value within a field and combine with AND across fields; all configuration conditions must match the bundle's own configuration. Search matches an entire file, suite, case_name or declared_case_name. Outcome and rerun_number must match the same attempt after replacement deduplication; every attempt in a matching bundle is returned, including attempts that do not match those filters. Sort by the documented run and catalog fields in ascending or descending order. started_at uses the earliest attempt start, ended_at the latest attempt end, and outcome and rerun_number the last attempt in chronological order. The default is newest bundle started_at first. Nulls always sort last, and owner ordering uses the alphabetically first label. Bundle identity fields break ties internally.";
export const RUNS_PAGE_DESCRIPTION = `${runGroupingDescription} ${runCatalogDescription} ${runWorkflowDescription} ${runReportDescription} ${runOptionsDescription}`;

export const runsApiOpenApi: ApiResource = {
  schemas: {
    GithubWorkflow: GithubWorkflowSchema,
    RunReport: RunReportSchema,
    RunAttempt: RunAttemptSchema,
    RunRecord: RunRecordSchema,
    RunListPage: RunListPageSchema,
  },
  paths: (ref) => ({
    "/api/tests/test/{test_id}/runs": {
      get: {
        operationId: "listRuns",
        tags: ["tests"],
        summary: "List runs of a test",
        description: `Returns retained test runs with their attempts bundled by configuration and GitHub job. By default every environment, env var set, outcome, time and code source is eligible. ${RUNS_PAGE_DESCRIPTION} Cursors bind the test ID, normalized filters and ordering. Cursors issued before attempt bundling are rejected with 400. Each page reads current data and may skip or repeat entries when data changes; pagination does not enumerate a fixed snapshot. An unknown test ID or filters matching no runs returns an empty page with 200.`,
        parameters: runsListParameters(),
        responses: {
          "200": jsonResponse(
            "A page of test run bundles with all attempts, shared catalog details, owners and workflow metadata.",
            ref(RunListPageSchema)
          ),
          ...listErrorResponses(ref),
        },
      },
    },
  }),
};
