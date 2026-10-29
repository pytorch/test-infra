import { RunsCursor } from "lib/api/tests/test/runs/cursor";
import { RunsListQuery } from "lib/api/tests/test/runs/parameters";
import {
  RunFields,
  RunRecord,
  RunStats,
  RunWorkflowFields,
} from "lib/api/tests/test/runs/types";

export const TEST_ID = "18446744073709551615";
export const RUN_ID = "0199fcc8-7748-7c24-b4d9-523079306ed4";
export const ENVIRONMENT_ID = "18446744073709551614";
export const ENV_VARS_ID = "18446744073709551613";
export const STARTED_AT = "2026-10-19T16:28:13.575Z";
export const ENDED_AT = "2026-10-19T16:28:13.576Z";
export const RUN_OUTCOMES: RunFields["outcome"][] = [
  "unknown",
  "passed",
  "failed",
  "error",
  "skipped",
  "xfailed",
  "xpassed",
  "crashed",
  "timed_out",
];

export function runStats(outcomes: readonly unknown[] = []): RunStats {
  return {
    total: outcomes.length,
    unknown: outcomes.filter((outcome) => outcome === "unknown").length,
    passed: outcomes.filter((outcome) => outcome === "passed").length,
    failed: outcomes.filter((outcome) => outcome === "failed").length,
    error: outcomes.filter((outcome) => outcome === "error").length,
    skipped: outcomes.filter((outcome) => outcome === "skipped").length,
    xfailed: outcomes.filter((outcome) => outcome === "xfailed").length,
    xpassed: outcomes.filter((outcome) => outcome === "xpassed").length,
    crashed: outcomes.filter((outcome) => outcome === "crashed").length,
    timed_out: outcomes.filter((outcome) => outcome === "timed_out").length,
  };
}

// The final outcome of each bundle among `records`, as the statistics count
// them: the last executed attempt's outcome in chronological order, or skipped
// when no attempt executed. Bundles keep their first-appearance order.
export function bundleOutcomes(
  records: readonly RunFields[]
): RunFields["outcome"][] {
  const bundles = new Map<string, RunFields[]>();
  for (const record of records) {
    const key = JSON.stringify([
      record.tests_id,
      record.environments_id,
      record.env_vars_id,
      record.github_workflow_job_id,
    ]);
    bundles.set(key, [...(bundles.get(key) ?? []), record]);
  }
  return Array.from(bundles.values(), (attempts) => {
    const ordered = [...attempts].sort((left, right) => {
      for (const field of ["started_at", "ended_at", "id"] as const) {
        if (left[field] !== right[field])
          return left[field] < right[field] ? -1 : 1;
      }
      return 0;
    });
    const executed = ordered.filter((attempt) => attempt.outcome !== "skipped");
    return (executed[executed.length - 1] ?? ordered[ordered.length - 1])
      .outcome;
  });
}

export const baseQuery: RunsListQuery = {
  test_id: TEST_ID,
  sort: ["-started_at"],
  limit: 2,
};

export const baseCursor: RunsCursor = {
  version: 2,
  resource: "test-runs",
  query: { test_id: TEST_ID, sort: ["-started_at"] },
  position: {
    values: [
      String(Date.parse(STARTED_AT)),
      ENVIRONMENT_ID,
      ENV_VARS_ID,
      "-9223372036854775808",
    ],
  },
};

export function runRecord(overrides: Partial<RunFields> = {}): RunFields {
  return {
    id: RUN_ID,
    tests_id: TEST_ID,
    environments_id: ENVIRONMENT_ID,
    env_vars_id: ENV_VARS_ID,
    github_workflow_job_id: "-9223372036854775808",
    report_uuid: "00000000-0000-4000-8000-000000000001",
    rerun_number: 0,
    outcome: "failed",
    outcome_summary: "AssertionError: \"Ünicode\"\nexpected 'a,b'",
    started_at: STARTED_AT,
    ended_at: ENDED_AT,
    ...overrides,
  };
}

export function expandedRunRecord(
  overrides: Omit<
    Partial<RunRecord & RunFields & RunWorkflowFields>,
    "github_workflow"
  > & {
    github_workflow?: Partial<RunRecord["github_workflow"]>;
    report?: RunRecord["attempts"][number]["report"];
  } = {}
): RunRecord {
  const { github_workflow, report, ...flatOverrides } = overrides;
  const {
    tests_id: _testId,
    environments_id: _environmentId,
    env_vars_id: _envVarsId,
    github_workflow_job_id,
    github_workflow_run_id,
    workflow_path,
    commit_sha,
    github_workflow_job_url,
    github_workflow_job_name,
    workflow_event,
    workflow_pull_request,
    report_uuid,
    test,
    environment,
    env_vars,
    owners,
    attempts,
    ...attempt
  } = {
    ...runRecord(),
    test: null,
    environment: null,
    env_vars: null,
    owners: [],
    attempts: undefined,
    github_workflow_run_id: null,
    workflow_path: null,
    commit_sha: null,
    github_workflow_job_url: null,
    github_workflow_job_name: null,
    workflow_event: null,
    workflow_pull_request: null,
    ...flatOverrides,
  };
  return {
    test,
    environment,
    env_vars,
    owners,
    attempts: attempts ?? [
      { ...attempt, report: report ?? { uuid: report_uuid, s3_url: null } },
    ],
    github_workflow: {
      job_id: github_workflow_job_id,
      run_id: github_workflow_run_id,
      path: workflow_path,
      commit_sha,
      job_url: github_workflow_job_url,
      job_name: github_workflow_job_name,
      event: workflow_event,
      pull_request: workflow_pull_request,
      ...github_workflow,
    },
  };
}

export function groupedRunRecord(records: RunFields[]): RunRecord {
  return {
    ...expandedRunRecord(records[0]),
    attempts: records.map((record) => expandedRunRecord(record).attempts[0]),
  };
}

// Group page rows deliberately contain no execution fields. This keeps mocks
// honest about the second query needed to retrieve every attempt in a bundle.
export function groupRow(overrides: Record<string, unknown> = {}) {
  const row = runRow(overrides);
  return Object.fromEntries(
    Object.entries(row).filter(
      ([key]) => key.endsWith("_id_string") || key.startsWith("sort_")
    )
  );
}

export function attemptRow(record: RunFields) {
  const {
    tests_id,
    environments_id,
    env_vars_id,
    github_workflow_job_id,
    ...attempt
  } = record;
  return {
    ...attempt,
    tests_id_string: tests_id,
    environments_id_string: environments_id,
    env_vars_id_string: env_vars_id,
    github_workflow_job_id_string: github_workflow_job_id,
  };
}

export function answerRunQueries(
  queryClickhouse: jest.SpyInstance,
  answers: {
    page?: Record<string, unknown>[];
    boundary?: Record<string, unknown>[];
    attempts?: Record<string, unknown>[];
    catalog?: Record<string, unknown>[];
    workflow?: Record<string, unknown>[];
    stats?: RunStats;
    detail?: Record<string, unknown>[];
  } = {}
) {
  queryClickhouse.mockImplementation(
    async (_sql: string, _params: unknown, queryId: string) => {
      switch (queryId) {
        case "api_test_runs_page":
        case "api_commit_runs_page":
          return answers.page ?? [];
        case "api_test_runs_page_boundary":
        case "api_commit_runs_page_boundary":
          return answers.boundary ?? [];
        case "api_run_attempts":
          return answers.attempts ?? [];
        case "api_run_catalog":
          return answers.catalog ?? [];
        case "api_run_workflow":
          return answers.workflow ?? [];
        case "api_commit_runs_stats":
          return [answers.stats ?? runStats()];
        case "api_run_detail":
          return answers.detail ?? [];
        default:
          throw new Error(`Unexpected query ${queryId}`);
      }
    }
  );
}

export function workflowRow(overrides: Record<string, unknown> = {}) {
  const jobId = String(
    overrides.github_workflow_job_id ?? "-9223372036854775808"
  );
  const workflowRunId = String(
    overrides.github_workflow_run_id ?? "9007199254740993"
  );
  return {
    github_workflow_job_id: jobId,
    github_workflow_run_id: workflowRunId,
    workflow_path: ".github/workflows/pull.yml",
    commit_sha: "0123456789abcdef0123456789abcdef01234567",
    github_workflow_job_url: `https://github.com/pytorch/pytorch/actions/runs/${workflowRunId}/job/${jobId}`,
    github_workflow_job_name:
      "linux-jammy-py3.10-gcc11 / test (default, 1, 5, linux.4xlarge)",
    workflow_event: null,
    ...overrides,
  };
}

export function runRow(overrides: Record<string, unknown> = {}) {
  const {
    tests_id,
    environments_id,
    env_vars_id,
    github_workflow_job_id,
    ...rest
  } = runRecord();
  return {
    tests_id_string: tests_id,
    environments_id_string: environments_id,
    env_vars_id_string: env_vars_id,
    github_workflow_job_id_string: github_workflow_job_id,
    ...rest,
    sort_0: String(Date.parse(STARTED_AT)),
    sort_1: environments_id,
    sort_2: env_vars_id,
    sort_3: github_workflow_job_id,
    ...overrides,
  };
}

// All legal single- and two-column orderings, including mixed directions.
export const SORT_CASES = [
  ["started_at"],
  ["-started_at"],
  ["ended_at"],
  ["-ended_at"],
  ["started_at", "ended_at"],
  ["started_at", "-ended_at"],
  ["-started_at", "ended_at"],
  ["-started_at", "-ended_at"],
  ["ended_at", "started_at"],
  ["ended_at", "-started_at"],
  ["-ended_at", "started_at"],
  ["-ended_at", "-started_at"],
].map((sort) => ({ sort }));
