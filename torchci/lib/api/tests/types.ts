import { PaginationSchema } from "lib/api/schema";
import {
  HEALTH_STATUSES,
  LANGUAGES,
  RAN_ONS,
  WINDOWS,
} from "lib/api/tests/parameters";
import { z } from "zod/v4";

// Response schemas mirror the ci catalogs. IDs are decimal UInt64 strings
// and timestamps are ISO 8601 in UTC.

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

function uint64String(description: string) {
  return z
    .string()
    .regex(/^\d{1,20}$/)
    .describe(`${description} A UInt64 as a decimal string.`);
}

function isoTimestamp(description: string) {
  return z.iso.datetime().describe(`${description} ISO 8601, UTC.`);
}

function count(description: string) {
  return z.number().int().nonnegative().describe(description);
}

function rate(description: string) {
  return z.number().min(0).max(1).nullable().describe(description);
}

export const TestRecordSchema = z
  .object({
    id: uint64String("Stable identity of the test, used in hub URLs."),
    repo: z
      .string()
      .describe("Repository the test lives in, e.g. pytorch/pytorch."),
    file: z
      .string()
      .describe(
        "File the test was launched from, repo-relative: test/test_torch.py; for C++ tests the test binary, e.g. cpp/test_api."
      ),
    suite: z
      .string()
      .describe(
        "Test class or C++ test suite; empty for module-level functions."
      ),
    case_name: z
      .string()
      .describe(
        "Test name exactly as the runner selects it, parameters included: test_add_cpu_float32."
      ),
    declared_case_name: z
      .string()
      .describe(
        "Test name as declared in the code, before the runner appends parameters: test_add. Equal to case_name for an unparametrized test; empty when unknown."
      ),
    language: z
      .enum(LANGUAGES)
      .describe("python for a .py test, cpp for a compiled test binary."),
    first_seen_at: isoTimestamp("When the catalog first saw the test."),
  })
  .describe("A test from the tests catalog.");

export const EnvironmentRecordSchema = z
  .object({
    id: uint64String("Identity of the environment."),
    os: z.string().describe("linux, macos or windows."),
    os_version: z
      .string()
      .describe(
        "OS or container image version: VERSION_ID on Linux (22.04), major.minor on macOS (15.7), the NT build on Windows (10.0.17763)."
      ),
    cpu_architecture: z.string().describe("x86_64, aarch64, s390x or ppc64le."),
    cpu_capability: z
      .string()
      .describe(
        "CPU kernel level: default, avx2, avx512, amx, sve128, sve256, vsx or zvector."
      ),
    python_version: z
      .string()
      .describe(
        "Interpreter major.minor, with a t suffix when free-threaded: 3.10, 3.14t."
      ),
    cc_compiler: z
      .string()
      .describe("Compiler that built torch: gcc, clang or msvc."),
    cc_compiler_version: z
      .string()
      .describe(
        "Version of that compiler as torch.__config__.show() prints it: 11.4 for gcc, 21.1.8 for clang, _MSC_FULL_VER for msvc (194234444)."
      ),
    accelerator: z
      .string()
      .describe(
        "What torch was built for: cpu, cuda, rocm, xpu or mps. A CUDA build on a CPU-only runner stays cuda with device_count 0."
      ),
    accelerator_version: z
      .string()
      .describe(
        "That stack's version as torch.version gives it: 13.2 for cuda, 10.1.0 for rocm; empty for cpu and mps."
      ),
    device_name: z
      .string()
      .describe(
        "The first visible accelerator's name as its vendor reports it, not normalized: NVIDIA L4, NVIDIA H100 80GB HBM3, Tesla T4, AMD Instinct MI350X VF, Apple M2 Pro. Empty when device_count is 0 or the name could not be read."
      ),
    device_count: count(
      "Accelerators visible to the test process, 0 for none."
    ),
    first_seen_at: isoTimestamp("When the catalog first saw the environment."),
  })
  .describe(
    "A hardware and build combination tests run on, from the environments catalog."
  );

export const EnvVarsRecordSchema = z
  .object({
    id: uint64String("Identity of the env var set."),
    values: z
      .record(z.string(), z.string())
      .describe(
        'The repro-relevant environment variables that were set, by name and value, e.g. {"PYTORCH_TEST_WITH_INDUCTOR": "1"}; variables that are off are absent.'
      ),
    first_seen_at: isoTimestamp("When the catalog first saw the set."),
  })
  .describe(
    "A set of environment variables in effect for a test process, from the env_vars catalog."
  );

export const HealthSummarySchema = z
  .object({
    window: z.enum(WINDOWS).describe("The window the counts cover."),
    ran_on: z
      .array(z.enum(RAN_ONS))
      .describe("The code sources the counts combine."),
    workflow_paths: z
      .array(z.string())
      .describe(
        "Sorted, unique calling workflow paths observed for this test, environment and env var set in the requested window and code sources, including retry and skipped attempts. Reusable workflow references are excluded. Empty when no paths are known."
      ),
    status: z
      .enum(HEALTH_STATUSES)
      .describe(
        "How the runs went, from the counts below: failing when a run's last attempt failed (failed_runs exceeds flaky_runs); flaky when every run with a failing attempt passed on retry (failed_runs equals flaky_runs, both above 0); healthy when no run failed; skipped when there are no runs, every attempt in the window having been skipped. Filter on it with the status parameter; sort on it worst first with -status."
      ),
    runs: count(
      "Runs of the test, retries after a failure folded into their run: passed_runs + failed_runs + runs with another outcome (xfailed, xpassed, unknown)."
    ),
    passed_runs: count("Runs that passed on their first attempt."),
    failed_runs: count(
      "Runs with at least one failing attempt, flaky ones included."
    ),
    flaky_runs: count(
      "Failed runs whose last attempt passed; a subset of failed_runs."
    ),
    skipped_runs: count("Attempts that were skipped; they are not in runs."),
    attempts: count(
      "Attempts in the window that were not skipped, first attempts and retries alike, each at its own start time; the denominator of mean_duration_milliseconds."
    ),
    pass_rate: rate("passed_runs / runs; null when runs is 0."),
    failure_rate: rate("failed_runs / runs; null when runs is 0."),
    flaky_rate: rate("flaky_runs / runs; null when runs is 0."),
    skip_rate: rate(
      "skipped_runs / (runs + skipped_runs); null when nothing ran or skipped."
    ),
    mean_passed_duration_milliseconds: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe(
        "Mean duration of the passed runs' first attempts; null without a pass. Prefer this over mean_duration_milliseconds for general test timing, because failures and timeouts can skew that metric."
      ),
    mean_duration_milliseconds: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe(
        "Mean duration of the attempts, failures, timeouts and retries included: total_duration_milliseconds / attempts, rounded half up; null when attempts is 0."
      ),
    total_duration_milliseconds: count(
      "Machine time the attempts took in total; 0 when nothing ran."
    ),
    last_run_at: z.iso
      .datetime()
      .nullable()
      .describe(
        "Start of the newest non-skipped attempt in the window. ISO 8601, UTC; null when none."
      ),
    last_failed_at: z.iso
      .datetime()
      .nullable()
      .describe(
        "Start of the newest failing attempt in the window. ISO 8601, UTC; null when none."
      ),
  })
  .describe(
    "The health rows of one entry over the requested window and code sources, combined into one: counts and the total duration summed, the passed mean weighted by passed runs, the mean of all attempts recomputed from the summed total and attempts, the timestamps the latest, the rates derived from the sums."
  );

export const TestHealthEntrySchema = z
  .object({
    test: TestRecordSchema,
    environment: EnvironmentRecordSchema.nullable().describe(
      "The environment; null if its catalog row is missing."
    ),
    env_vars: EnvVarsRecordSchema.nullable().describe(
      "The env var set; null if its catalog row is missing."
    ),
    owners: z
      .array(z.string())
      .describe(
        'Owner labels of the test\'s file from the owners table, without the "module: " prefix, e.g. ["nn"] or ["core_tests"]; empty when the file has none.'
      ),
    health: HealthSummarySchema,
  })
  .describe(
    "One test in one environment with one env var set, and its health."
  );

export const TestListPageSchema = z
  .object({
    tests: z
      .array(TestHealthEntrySchema)
      .describe(
        "Test configurations in the requested order, including their environment and env var set."
      ),
    pagination: PaginationSchema.describe(
      "Next and previous page links; each is null when no entries were found in that direction. Both are null on an empty page; restart without cursor. Cursors remain usable after health refreshes. Pages read current data and may skip or repeat entries when data or sort values change; they do not enumerate a fixed snapshot."
    ),
    refreshed_at: isoTimestamp("Health-table refresh timestamp.")
      .nullable()
      .describe(
        "For a nonempty page, the health refresh timestamp read with its rows. For an empty page, the current refresh timestamp read after the page query; null if the health table is empty at that read. An empty page and its timestamp need not reflect the same snapshot. ISO 8601, UTC."
      ),
    query_duration_ms: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Elapsed time in milliseconds from starting the page's ClickHouse request until it and any empty-page refresh lookup finish, plus the individually rounded boundary-probe duration for nonempty cursor pages. Includes ClickHouse client and network overhead and response decoding. Excludes SQL construction, response mapping, cursor encoding, API routing and transport between the caller and the API."
      ),
  })
  .describe("A page of GET /api/tests.");

export const TestConfigurationHealthSchema = TestHealthEntrySchema.pick({
  environment: true,
  env_vars: true,
  health: true,
}).describe("Health of one test configuration in one window and code source.");

export type TestRecord = z.infer<typeof TestRecordSchema>;
export type EnvironmentRecord = z.infer<typeof EnvironmentRecordSchema>;
export type EnvVarsRecord = z.infer<typeof EnvVarsRecordSchema>;
export type HealthSummary = z.infer<typeof HealthSummarySchema>;
export type TestHealthEntry = z.infer<typeof TestHealthEntrySchema>;
export type TestListPage = z.infer<typeof TestListPageSchema>;
export type TestConfigurationHealth = z.infer<
  typeof TestConfigurationHealthSchema
>;
