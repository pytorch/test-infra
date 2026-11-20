import {
  CommitJobSchema,
  FailingAttemptsSchema,
  JobStatusCountsSchema,
  JobTestsSchema,
} from "lib/api/tests/commit/jobs/types";
import { TestListPageSchema } from "lib/api/tests/types";
import { z } from "zod/v4";

const time = z.iso.datetime();

export const JobStepSchema = z
  .object({
    name: z.string().describe("The step's name."),
    conclusion: z
      .string()
      .nullable()
      .describe(
        "GitHub's conclusion: success, failure, cancelled or skipped; null until the step ends."
      ),
    started_at: time.nullable().describe("When the step started; null if not."),
    completed_at: time.nullable().describe("When the step ended; null if not."),
  })
  .describe("A step of a GitHub job.");

export const JOB_FILE_RUN_STATUSES = [
  "failed",
  "flaky",
  "passed",
  "skipped",
] as const;

export const JobTestFileSchema = z
  .object({
    file: z
      .string()
      .nullable()
      .describe(
        "The test file, repository-relative; null for tests missing from the catalog."
      ),
    tests_by_status: JobStatusCountsSchema,
    runs: z
      .array(
        z.object({
          started_at: time.describe("When the run's first attempt started."),
          ended_at: time.describe("When the run's last attempt ended."),
          status: z
            .enum(JOB_FILE_RUN_STATUSES)
            .describe(
              "failed when an attempt failed in a bundle that ended failed or timed out; else flaky when an attempt failed; else skipped when no attempt executed; else passed."
            ),
        })
      )
      .describe(
        "The file's runs in the job, in order: each launch of the file in its own process, one test report."
      ),
    failing_attempts: FailingAttemptsSchema,
  })
  .describe("A test file in one job.");

export const JobDetailSchema = z
  .object({
    job: CommitJobSchema,
    tests: JobTestsSchema.nullable().describe(
      "What the job's recorded tests did; null for a job with no retained test run."
    ),
    steps: z.array(JobStepSchema).describe("The job's steps, in order."),
    files: z
      .array(JobTestFileSchema)
      .describe(
        "The job's test files, in the order they first ran. Their bundles by status add up to the job's."
      ),
    hud_url: TestListPageSchema.shape.hud_url.describe(
      "The HUD page of the job's commit, the commitPage operation, opened on this job; null when HUD has no record of the job's workflow run."
    ),
    query_duration_ms: TestListPageSchema.shape.query_duration_ms.describe(
      "Sum of the individually rounded elapsed milliseconds of the job read and the two test runs reads, which run concurrently, so this sum can exceed wall-clock time."
    ),
  })
  .describe("One GitHub job: its steps and what its test files did.");

export type JobDetail = z.infer<typeof JobDetailSchema>;
export type JobTestFile = z.infer<typeof JobTestFileSchema>;
