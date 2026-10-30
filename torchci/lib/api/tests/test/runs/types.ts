import { RunIdSchema } from "lib/api/tests/run/parameters";
import {
  TestHealthEntrySchema,
  TestListPageSchema,
  TestRecordSchema,
} from "lib/api/tests/types";
import { RUN_OUTCOMES } from "lib/runOutcomes";
import { z } from "zod/v4";

// Undecorated validators are shared with query filters. Response descriptions
// belong on the record fields, not on filter parameter item schemas. The
// outcomes are the page's too (lib/runOutcomes.ts).
export const RunRerunNumberSchema = z.number().int().min(0).max(65535);
export const RunOutcomeSchema = z.enum(RUN_OUTCOMES);

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
    event: z
      .string()
      .nullable()
      .describe(
        "Trigger event from workflow_run.event, for example pull_request, pull_request_target, push, schedule or workflow_dispatch; null if unavailable. Use this field to identify a PR-triggered workflow. PR associations alone do not identify the trigger."
      ),
    pull_request: z
      .object({
        number: z
          .number()
          .int()
          .positive()
          .max(Number.MAX_SAFE_INTEGER)
          .describe("Pull request number within the workflow's repository."),
        url: z
          .url()
          .describe(
            "GitHub browser URL for this pull request targeting the workflow's repository, derived from its recorded API URL."
          ),
      })
      .nullable()
      .describe(
        "The unique pull request recorded in workflow_run.pull_requests whose base repository ID matches the workflow's repository ID, with a valid number and URL. Duplicate records of the same PR are collapsed. Null if no matching PR is recorded, required metadata is unavailable, or multiple distinct matching PRs make the association ambiguous. PRs syncing upstream changes into other forks are excluded. GitHub can omit associations even for PR-triggered runs; push workflows can also have an associated PR, so use event to identify a PR trigger."
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
      "UUID of this individual test execution, distinct from the report UUID and GitHub workflow run ID."
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
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;
export { RUN_OUTCOMES };

const runCount = z.number().int().nonnegative();
export const RunStatsSchema = z
  .object({
    total: runCount.describe(
      "Exact number of retained bundles in the requested scope after replacement deduplication: one per test, environment, env var set and GitHub job, however many attempts it holds."
    ),
    ...(Object.fromEntries(
      RUN_OUTCOMES.map((outcome) => [
        outcome,
        runCount.describe(
          `Number of retained bundles whose final outcome is ${outcome}: the recorded outcome of the bundle's chronologically last executed attempt, or skipped when every attempt was skipped.`
        ),
      ])
    ) as Record<RunOutcome, typeof runCount>),
  })
  .describe(
    "Exact bundle counts by final outcome for the entire requested scope. Retries are flattened: each bundle counts once, under the outcome of its last executed attempt in started_at, ended_at and id order, so a test that failed and then passed on retry counts as passed. A skipped attempt never overrides an executed one: a test that timed out or failed and was then skipped in its rerun did not recover, so that bundle keeps its timed_out or failed outcome. A bundle whose attempts were all skipped counts as skipped. This is the only way the final outcome differs from the last_attempt_outcome filter. Each counter counts only its named outcome; the counters sum to total. Bundles that ended passing are counted in passed. failed counts only a final failed outcome; error, crashed, timed_out, xfailed and xpassed are reported separately. Search and all run filters, including outcome and last_attempt_outcome, are ignored. Ordering and pagination do not affect counts. A scope with no retained bundles has zero in every field."
  );

export const RunListPageSchema = z
  .object({
    runs: z
      .array(RunRecordSchema)
      .describe(
        "Attempt bundles in the requested order, with shared catalog details and workflow metadata. A bundle is never split across pages."
      ),
    pagination: TestListPageSchema.shape.pagination.describe(
      "Next and previous page links; each is null when no runs were found in that direction. Both are null on an empty page; restart without cursor. Previous pages keep the requested order. Continue on the same endpoint with the same test ID or repository and commit SHA, filters and sort order; page size may change. Pages read current data, so ingestion, replacements or retention expiry may change subsequent pages; this is not a fixed snapshot."
    ),
    query_duration_ms: TestListPageSchema.shape.query_duration_ms.describe(
      "Sum of the individually rounded elapsed milliseconds for the bundle page, the boundary probe on nonempty cursor pages, all attempts in the selected bundles, the batched catalog lookup and the batched workflow metadata lookup. Catalog and workflow lookups run concurrently after the attempts lookup, so this sum can exceed wall-clock time. Only the bundle page is queried for an empty page. Includes client and network overhead and decoding; excludes SQL construction, mapping, cursor encoding and API transport."
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
  workflow_event: GithubWorkflow["event"];
  workflow_pull_request: GithubWorkflow["pull_request"];
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

// ---------------------------------------------------------------------------
// The runs grouped by commit (group_by=commit)
// ---------------------------------------------------------------------------

export const RunGridCommitSchema = z
  .object({
    sha: z
      .string()
      .regex(/^[0-9a-f]{40}$/i)
      .describe(
        "Commit SHA from workflow_run.head_sha, as the bundles' github_workflow.commit_sha."
      ),
    started_at: z.iso
      .datetime()
      .describe(
        "Start of the earliest attempt of this test on the commit among the lanes and jobs returned, in ISO 8601 UTC with millisecond precision. Commits are ordered by it, then by SHA."
      ),
  })
  .describe("A commit the test ran on, in at least one lane.");

export const RunGridJobSchema = z
  .object({
    job_id: GithubWorkflowSchema.shape.job_id,
    job_url: GithubWorkflowSchema.shape.job_url,
    job_name: GithubWorkflowSchema.shape.job_name,
    outcome: RunOutcomeSchema.describe(
      "The job's final outcome, the rule of the commit statistics' bundles: the recorded outcome of its chronologically last executed attempt, or skipped when every attempt in the job was skipped. A skip never overrides an executed attempt."
    ),
    attempts: z
      .array(RunOutcomeSchema)
      .min(1)
      .describe(
        "The recorded outcome of each attempt the test had in this job, in chronological order (started_at, ended_at, id): the first execution and the launcher's reruns of it in fresh processes. A failure followed by passed is a run that recovered on a rerun."
      ),
    started_at: z.iso
      .datetime()
      .describe(
        "Start of the job's earliest attempt, in ISO 8601 UTC with millisecond precision."
      ),
    duration_milliseconds: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Sum of this job's executed attempts' durations, each max(0, ended_at - started_at); 0 when every attempt was skipped."
      ),
    passed_duration_milliseconds: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Sum of this job's passed attempts' durations alone, each max(0, ended_at - started_at); 0 when none passed."
      ),
    decisive: z
      .boolean()
      .describe(
        "True for the one job that holds the cell's deciding attempt: in the retry sequence the cell's outcome comes from, the last job that executed anything, or the last job when none did (see the cell's outcome)."
      ),
  })
  .describe(
    "One GitHub job's attempts of the test in the cell's configuration and calling workflow on the commit, the launcher's reruns included: a chain of attempts in one job."
  );

export const RunGridCellSchema = z
  .object({
    commit_sha: RunGridCommitSchema.shape.sha,
    outcome: RunOutcomeSchema.describe(
      "The cell's final outcome. Jobs with the same name are one retry sequence in time order, a job and its re-run, whether in one workflow run or across runs of the same workflow on the commit (a scheduled workflow repeating on an unchanged head reruns its jobs too), judged as the commit statistics judge a bundle: the recorded outcome of the sequence's last executed attempt, or skipped when nothing in it executed, a skip never overriding an executed attempt. Jobs with different names are siblings, shards that each ran the test, and the worst sibling's outcome is the cell's: a failing final outcome (failed, error, crashed or timed_out) before a pass that followed a failing attempt, before xfailed, xpassed or unknown, before passed, before skipped; among equals, the sequence whose last job started last, then the one with the greater job id. The decisive job is the job of that sequence's deciding attempt: its last job, by start, that executed anything, or its last job when none did; the bundle rule's last executed attempt, since a re-run starts after the job it re-runs ended."
    ),
    started_at: z.iso
      .datetime()
      .describe(
        "Start of the cell's earliest attempt, in ISO 8601 UTC with millisecond precision."
      ),
    duration_milliseconds: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Sum over every job of the executed attempts' durations, each max(0, ended_at - started_at): the commit's whole spend on the test in this configuration and workflow; 0 when every attempt was skipped."
      ),
    passed_duration_milliseconds: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "The test's time when it passed on the commit, one run's time: each retry sequence that ended passing contributes the mean over its jobs that passed of their passed attempts' summed durations, without the failed attempts a rerun recovered from, and the cell takes the mean over those sequences, rounded to the millisecond, so sibling shards, and a job and its re-run, that each passed count as one run; 0 when no retry sequence ended passing."
      ),
    jobs: z
      .array(RunGridJobSchema)
      .min(1)
      .describe(
        "The jobs whose attempts make the cell, ordered by their earliest attempt, then job id; exactly one is decisive."
      ),
  })
  .describe(
    "Every attempt of the test, in one configuration and calling workflow, on one commit, folded into one cell, job by job."
  );

export const RunGridLaneSchema = z
  .object({
    workflow_path: GithubWorkflowSchema.shape.path,
    environment: TestHealthEntrySchema.shape.environment,
    env_vars: TestHealthEntrySchema.shape.env_vars,
    cells: z
      .array(RunGridCellSchema)
      .min(1)
      .describe(
        "The lane's cells, ordered by started_at, then commit SHA; one per commit."
      ),
  })
  .describe(
    "One calling workflow, environment and env var set the test ran in, with a cell for each commit it ran on. Lanes are ordered by workflow path, a lane without a path first, then by environment ID and env var set ID as numbers."
  );

export const RunGridSchema = z
  .object({
    commits: z
      .array(RunGridCommitSchema)
      .describe(
        "Every commit with a cell in some lane, ordered by the start of the test's earliest attempt on it, oldest first."
      ),
    lanes: z
      .array(RunGridLaneSchema)
      .describe(
        "The lanes with at least one cell, ordered by workflow path, a lane without a path first, then by environment ID and env var set ID as numbers."
      ),
    hud_url: z
      .url()
      .nullable()
      .describe(
        "The test's HUD page (testPage) showing these runs, as an absolute URL: ran_on and window carried, each spelled as the widest choice when the request left it out (both code sources, which leaves out only the jobs that belong to neither; 14d, the retention), and one environments_id with one env_vars_id as the page's marked configuration, shown among the others. Null when the grid is empty, since the test's repository is read with its lanes, and when the request narrowed the lanes in a way the page cannot show: any other catalog filter, env_vars, workflow_path, or several ids."
      ),
    query_duration_ms: TestListPageSchema.shape.query_duration_ms.describe(
      "Sum of the individually rounded elapsed milliseconds of the grouped read and the catalog lookup. Includes client and network overhead and decoding; excludes SQL construction, mapping and API transport."
    ),
  })
  .describe(
    "A test's retained runs as a grid: lanes down, commits across, every attempt of a configuration on a commit folded into one cell. Replacement rows are deduplicated before grouping. Runs whose job has no retained metadata row, or whose workflow run is not retained or has no commit, are left out, and appear once it lands. With a window, jobs whose first attempt started before it are left out whole, so no job's chain is cut. Empty lanes and commits for a test with no matching runs."
  );

export type RunGridCommit = z.infer<typeof RunGridCommitSchema>;
export type RunGridJob = z.infer<typeof RunGridJobSchema>;
export type RunGridCell = z.infer<typeof RunGridCellSchema>;
export type RunGridLane = z.infer<typeof RunGridLaneSchema>;
export type RunGrid = z.infer<typeof RunGridSchema>;
