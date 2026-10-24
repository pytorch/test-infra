import { RunIdSchema } from "lib/api/tests/run/parameters";
import {
  TestHealthEntrySchema,
  TestListPageSchema,
  TestRecordSchema,
} from "lib/api/tests/types";
import { z } from "zod/v4";

// Undecorated validators are shared with query filters. Response descriptions
// belong on the record fields, not on filter parameter item schemas.
export const RunRerunNumberSchema = z.number().int().min(0).max(65535);
export const RunOutcomeSchema = z.enum([
  "unknown",
  "passed",
  "failed",
  "error",
  "skipped",
  "xfailed",
  "xpassed",
  "crashed",
  "timed_out",
]);

export const GithubWorkflowSchema = z
  .object({
    job_id: z
      .string()
      .regex(/^-?\d{1,19}$/)
      .describe("GitHub workflow job ID, as a signed Int64 decimal string."),
    run_id: z
      .string()
      .regex(/^-?\d{1,19}$/)
      .nullable()
      .describe(
        "GitHub Actions workflow run ID associated with this job, as a signed Int64 decimal string. Available from the job even if workflow run metadata is missing; null if the job's workflow run ID is unavailable."
      ),
    path: z
      .string()
      .nullable()
      .describe(
        "Calling workflow file path from workflow_run.path, for example .github/workflows/trunk.yml; null if unavailable."
      ),
    commit_sha: z
      .string()
      .regex(/^[0-9a-f]{40}$/i)
      .nullable()
      .describe(
        "Commit SHA from workflow_run.head_sha, consistent with commit endpoint selection. This may differ from the merge SHA recorded on pull-request jobs; null if unavailable."
      ),
    job_url: z
      .url()
      .nullable()
      .describe(
        "GitHub Actions job page URL from workflow_job.html_url, for example https://github.com/pytorch/pytorch/actions/runs/123/job/456; null if unavailable. Identifies the job that produced this test run and is available even when workflow run metadata is missing."
      ),
    job_name: z
      .string()
      .nullable()
      .describe(
        "GitHub Actions job name from workflow_job.name, for example unit-test / inductor-cpu-core-test (3.12) / test (inductor_core, 1, 2, mt-l-x86iavx512-8-64); null if unavailable. Jobs in reusable workflows are prefixed by their calling jobs' names, separated by ' / '; the workflow name is not included. Available even when workflow run metadata is missing."
      ),
  })
  .describe(
    "GitHub Actions job and workflow metadata for this test run. This object is always present and job_id identifies the job recorded on the run. Unavailable metadata fields are null."
  );

export const RunReportSchema = z
  .object({
    uuid: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
      .describe("UUID of the source test report."),
    s3_url: z
      .url()
      .nullable()
      .describe(
        "HTTPS URL of the source JSONL report in the gha-artifacts S3 bucket, inferred from the standard Python or C++ report filename and its repository, workflow run ID and job ID. Custom report filename prefixes are not recorded in the database. Null if the required metadata is missing, invalid or does not identify a standard report path."
      ),
  })
  .describe(
    "Source test report. The UUID is always present; the S3 URL is null when its location is unavailable."
  );

export const RunAttemptSchema = z
  .object({
    id: RunIdSchema.describe(
      "UUID of this individual test execution. Use as run_id in GET /api/tests/run/{run_id} to retrieve its complete attempt bundle; distinct from the report UUID and GitHub workflow run ID."
    ),
    report: RunReportSchema,
    rerun_number: RunRerunNumberSchema.describe(
      "Zero-based execution index for this collected test within one report (report.uuid). The reporter increments it when an execution finishes, regardless of outcome. Pytest executions and intentional flakefinder repetitions both advance it; subtests share their parent execution. It resets for each new report, including attempts in a fresh process, independently of GitHub workflow/job attempts. A bundle can therefore contain several executions numbered 0. A positive value alone does not imply a previous failure. The attempts array uses started_at, ended_at and id for chronological ordering across reports."
    ),
    outcome: RunOutcomeSchema.describe("Outcome recorded for this attempt."),
    outcome_summary: z.string().describe("Recorded outcome details, if any."),
    started_at: z.iso
      .datetime()
      .describe(
        "Attempt start time, in ISO 8601 UTC with millisecond precision."
      ),
    ended_at: z.iso
      .datetime()
      .describe(
        "Attempt end time, in ISO 8601 UTC with millisecond precision."
      ),
  })
  .describe(
    "One retained execution in an attempt bundle, including the initial execution. Its UUID, source report, original execution number and recorded outcome are preserved."
  );

export const RunRecordSchema = z
  .object({
    github_workflow: GithubWorkflowSchema,
    test: TestRecordSchema.nullable().describe(
      "The test; null if its catalog row is missing."
    ),
    environment: TestHealthEntrySchema.shape.environment,
    env_vars: TestHealthEntrySchema.shape.env_vars,
    owners: TestHealthEntrySchema.shape.owners,
    attempts: z
      .array(RunAttemptSchema)
      .min(1)
      .describe(
        "All retained executions of this test and configuration in this GitHub job, including the initial execution, attempts in fresh processes and intentional repetitions. Ordered by started_at, then ended_at, then id ascending. Includes every report and every outcome even when only one attempt matched the request's filters."
      ),
  })
  .describe(
    "A bundle of executions sharing the internal test ID, environment ID, env var set ID and GitHub job ID. Shared metadata appears once; individual executions are in attempts. Replacement rows are deduplicated before grouping. Catalogs and owners reflect current data. Missing catalogs or workflow metadata do not remove a bundle or merge it with another configuration. Workflow metadata uses the latest retained records."
  );

// Records, filters, statistics and SQL aggregation share the same outcomes.
type RunOutcome = z.infer<typeof RunOutcomeSchema>;
export const RUN_OUTCOMES = RunOutcomeSchema.options;

const runCount = z.number().int().nonnegative();
export const RunStatsSchema = z
  .object({
    total: runCount.describe(
      "Exact number of retained individual executions in the requested scope after replacement deduplication. Counts the initial execution and every attempt, not the number of bundles."
    ),
    ...(Object.fromEntries(
      RUN_OUTCOMES.map((outcome) => [
        outcome,
        runCount.describe(
          `Number of retained individual executions with recorded outcome ${outcome}. Counts only this exact outcome, including initial executions and attempts.`
        ),
      ])
    ) as Record<RunOutcome, typeof runCount>),
  })
  .describe(
    "Exact individual-execution counts for the entire requested scope, including the initial execution and every attempt; these are not bundle counts. Each outcome counter counts only its named recorded outcome; the counters sum to total. Successful executions are counted in passed. failed counts only failed outcomes; error, crashed, timed_out, xfailed and xpassed are reported separately. Search and all run filters, including outcome, are ignored. Ordering and pagination do not affect counts. A scope with no retained executions has zero in every field."
  );

export const RunListPageSchema = z
  .object({
    runs: z
      .array(RunRecordSchema)
      .describe(
        "Attempt bundles in the requested order, with shared catalog details and workflow metadata. A bundle is never split across pages."
      ),
    next_cursor: TestListPageSchema.shape.next_cursor.describe(
      "Pass back to the same endpoint with the same test ID or repository and commit SHA, filters and sort order to continue; page size may change. Null when no further runs were found. Pages read current data, so ingestion, replacements or retention expiry may change subsequent pages; this is not a fixed snapshot."
    ),
    query_duration_ms: TestListPageSchema.shape.query_duration_ms.describe(
      "Sum of the individually rounded elapsed milliseconds for the bundle page, all attempts in the selected bundles, the batched catalog lookup and the batched workflow metadata lookup. Catalog and workflow lookups run concurrently after the attempts lookup, so this sum can exceed wall-clock time. Only the bundle page is queried for an empty page. Includes client and network overhead and decoding; excludes SQL construction, mapping, cursor encoding and API transport."
    ),
  })
  .describe(
    "A page of complete attempt bundles with shared catalog details, owners and workflow metadata."
  );

export type RunRecord = z.infer<typeof RunRecordSchema>;
export type RunAttempt = z.infer<typeof RunAttemptSchema>;
export type RunStats = z.infer<typeof RunStatsSchema>;
export type GithubWorkflow = z.infer<typeof GithubWorkflowSchema>;
// Flat metadata fields are internal to the batched workflow lookup.
export type RunWorkflowFields = {
  github_workflow_run_id: GithubWorkflow["run_id"];
  workflow_path: GithubWorkflow["path"];
  commit_sha: GithubWorkflow["commit_sha"];
  github_workflow_job_url: GithubWorkflow["job_url"];
  github_workflow_job_name: GithubWorkflow["job_name"];
};
// Foreign keys and the flat report UUID stay internal until metadata expansion.
export type RunFields = Omit<RunAttempt, "report"> & {
  report_uuid: RunAttempt["report"]["uuid"];
  github_workflow_job_id: GithubWorkflow["job_id"];
  tests_id: string;
  environments_id: string;
  env_vars_id: string;
};
export type RunGroup = Pick<
  RunFields,
  "tests_id" | "environments_id" | "env_vars_id" | "github_workflow_job_id"
>;
export type RunCatalogRecord = Omit<
  RunFields,
  "tests_id" | "environments_id" | "env_vars_id"
> &
  Pick<RunRecord, "test" | "environment" | "env_vars" | "owners">;
export type RunListPage = z.infer<typeof RunListPageSchema>;
