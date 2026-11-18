import { GithubWorkflowSchema } from "lib/api/tests/test/runs/types";
import { TestListPageSchema } from "lib/api/tests/types";
import { BUNDLE_STATUSES, BundleStatus } from "lib/runOutcomes";
import { z } from "zod/v4";

const time = z.iso.datetime();

export const JobStatusCountsSchema = z
  .object(
    Object.fromEntries(
      BUNDLE_STATUSES.map((status) => [
        status,
        z
          .number()
          .int()
          .nonnegative()
          .describe(`Bundles whose status is ${status}.`),
      ])
    ) as Record<BundleStatus, z.ZodNumber>
  )
  .describe(
    "Bundles by status, one bundle per test, environment and env var set, by the status rule of GET /api/tests/commit/{sha}."
  );

export const FailingAttemptsSchema = z
  .object({
    failed: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Attempts that failed in a bundle that ended failed or timed out."
      ),
    flaky: z
      .number()
      .int()
      .nonnegative()
      .describe("Attempts that failed in a bundle that did not end so."),
  })
  .describe("How many attempts failed (failed, error, crashed or timed_out).");

const stepWindow = (what: string) =>
  z
    .object({
      started_at: time.describe("When the step started."),
      completed_at: time
        .nullable()
        .describe("When the step ended; null while it runs."),
    })
    .nullable()
    .describe(what);

export const CommitJobSchema = z
  .object({
    id: GithubWorkflowSchema.shape.job_id,
    name: z.string().describe("The job's name, as GitHub records it."),
    url: z.string().nullable().describe("The job's page on GitHub."),
    workflow: z
      .object({
        run_id: GithubWorkflowSchema.shape.run_id.unwrap(),
        run_attempt: z
          .number()
          .int()
          .describe(
            "The attempt of the run that the job ran in, from workflow_job.run_attempt: 1, and more for a job of a rerun."
          ),
        name: z.string().nullable().describe("The workflow's name."),
        path: GithubWorkflowSchema.shape.path,
        event: GithubWorkflowSchema.shape.event,
      })
      .describe(
        "The workflow run the job belongs to; the fields but run_id are null when HUD has no record of the run."
      ),
    status: z
      .string()
      .describe("GitHub's status: queued, in_progress or completed."),
    conclusion: z
      .string()
      .nullable()
      .describe(
        "GitHub's conclusion: success, failure, cancelled or skipped; null until the job completes."
      ),
    created_at: time.describe("When GitHub created the job."),
    started_at: time
      .nullable()
      .describe(
        "When a runner took the job; null for a job none took, one that waits still or that ended waiting."
      ),
    completed_at: time
      .nullable()
      .describe("When the job ended; null until then."),
    labels: z
      .array(z.string())
      .describe("The runner labels the job asked for."),
    container_step: stepWindow(
      "The job's Initialize containers step, when the job has a runner and waits for its container; null for a job without one."
    ),
    test_step: stepWindow(
      "The job's Test step, the longest when several ran; null for a job without one."
    ),
    failed_step: z
      .string()
      .nullable()
      .describe(
        "The first step that failed, or that a cancelled job was cancelled in; null for none."
      ),
    failure_line: z
      .string()
      .nullable()
      .describe(
        "The line of the job's log that HUD's log classifier picked; null for none."
      ),
  })
  .describe("A GitHub job with its times.");

export const JobTestsSchema = z
  .object({
    by_status: JobStatusCountsSchema,
    running: z
      .array(
        z.object({
          started_at: time.describe("The stretch's start."),
          ended_at: time.describe("The stretch's end."),
        })
      )
      .describe(
        "The stretches in which at least one recorded test attempt was running, in order, in steps of 5 seconds: an attempt covers each step it ran in. Skipped attempts cover nothing."
      ),
    failing_attempts: FailingAttemptsSchema,
  })
  .describe(
    "What a job's recorded tests did, after replacement deduplication."
  );

export const CommitJobTestsSchema = z
  .object({ job_id: CommitJobSchema.shape.id, ...JobTestsSchema.shape })
  .describe("What the recorded tests of one job of a commit did.");

// The fields a request can name, each one read.
export const CommitJobsFieldsSchema = z.object({
  jobs: z
    .array(CommitJobSchema)
    .describe("Every job of the commit, in job ID order."),
  tests: z
    .array(CommitJobTestsSchema)
    .describe(
      "What the recorded tests of the commit's jobs did, in job ID order: an entry for each job with a retained test run, and none for a job without."
    ),
});

export const CommitJobsSchema = CommitJobsFieldsSchema.partial()
  .extend({
    hud_url: TestListPageSchema.shape.hud_url
      .unwrap()
      .describe(
        "The HUD page for the commit's tests, the commitPage operation, with no parameters."
      ),
    query_duration_ms: TestListPageSchema.shape.query_duration_ms.describe(
      "Sum of the individually rounded elapsed milliseconds of the reads made, the jobs read and the test runs read, which run concurrently, so this sum can exceed wall-clock time."
    ),
  })
  .describe(
    "The jobs of one commit and what their tests did, for a timeline of the commit. Both fields unless the fields parameter names one, then that one; hud_url and query_duration_ms always."
  );

export type CommitJob = z.infer<typeof CommitJobSchema>;
export type JobTests = z.infer<typeof JobTestsSchema>;
export type CommitJobTests = z.infer<typeof CommitJobTestsSchema>;
export type CommitJobs = z.infer<typeof CommitJobsSchema>;
export type JobStatusCounts = z.infer<typeof JobStatusCountsSchema>;
