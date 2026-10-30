import { testPageLinkForEntry, testPageUrl } from "lib/api/tests/pages/links";
import {
  EnvironmentRecord,
  EnvVarsRecord,
  HealthSummary,
  TestConfigurationHealth,
  TestHealthEntry,
  TestRecord,
} from "lib/api/tests/types";

export interface EntityRow {
  [key: string]: unknown;
  repo: string;
  file: string;
  suite: string;
  case_name: string;
  declared_case_name: string;
  language: TestRecord["language"];
  first_seen_at: string;
  owners: string[];
  has_health: number;
  tests_id_string: string;
  workflow_paths_combined: HealthSummary["workflow_paths"];
  status: HealthSummary["status"];
  runs_combined: number;
  passed_runs_combined: number;
  failed_runs_combined: number;
  flaky_runs_combined: number;
  skipped_runs_combined: number;
  attempts_combined: number;
  pass_rate: number | null;
  failure_rate: number | null;
  flaky_rate: number | null;
  skip_rate: number | null;
  mean_passed_duration_milliseconds_combined: number | null;
  mean_duration_milliseconds_combined: number | null;
  total_duration_milliseconds_combined: number;
  last_run_at_combined: string | null;
  last_failed_at_combined: string | null;
  refreshed_at: string;
  environment_id_string: string;
  os: string;
  os_version: string;
  cpu_architecture: string;
  cpu_capability: string;
  python_version: string;
  cc_compiler: string;
  cc_compiler_version: string;
  accelerator: string;
  accelerator_version: string;
  device_name: string;
  device_count: number;
  environment_first_seen_at: string;
  env_var_set_id_string: string;
  env_vars: Record<string, string>;
  env_vars_first_seen_at: string;
}

export type TestRow = Pick<
  EntityRow,
  | "tests_id_string"
  | "repo"
  | "file"
  | "suite"
  | "case_name"
  | "declared_case_name"
  | "language"
  | "first_seen_at"
>;

export type EnvironmentRow = Pick<
  EntityRow,
  | "environment_id_string"
  | "os"
  | "os_version"
  | "cpu_architecture"
  | "cpu_capability"
  | "python_version"
  | "cc_compiler"
  | "cc_compiler_version"
  | "accelerator"
  | "accelerator_version"
  | "device_name"
  | "device_count"
  | "environment_first_seen_at"
>;

export type EnvVarsRow = Pick<
  EntityRow,
  "env_var_set_id_string" | "env_vars" | "env_vars_first_seen_at"
>;

export function toTest(row: TestRow): TestRecord {
  return {
    id: row.tests_id_string,
    hud_url: testPageUrl(row.repo, row.tests_id_string),
    repo: row.repo,
    file: row.file,
    suite: row.suite,
    case_name: row.case_name,
    declared_case_name: row.declared_case_name,
    language: row.language,
    first_seen_at: row.first_seen_at,
  };
}

export function toEnvironment(row: EnvironmentRow): EnvironmentRecord {
  return {
    id: row.environment_id_string,
    os: row.os,
    os_version: row.os_version,
    cpu_architecture: row.cpu_architecture,
    cpu_capability: row.cpu_capability,
    python_version: row.python_version,
    cc_compiler: row.cc_compiler,
    cc_compiler_version: row.cc_compiler_version,
    accelerator: row.accelerator,
    accelerator_version: row.accelerator_version,
    device_name: row.device_name,
    device_count: row.device_count,
    first_seen_at: row.environment_first_seen_at,
  };
}

export function toEnvVars(row: EnvVarsRow): EnvVarsRecord {
  return {
    id: row.env_var_set_id_string,
    values: row.env_vars,
    first_seen_at: row.env_vars_first_seen_at,
  };
}

function toHealth(
  row: EntityRow,
  query: Pick<HealthSummary, "window" | "ran_on">
): HealthSummary {
  return {
    window: query.window,
    ran_on: query.ran_on,
    workflow_paths: row.workflow_paths_combined,
    status: row.status,
    runs: row.runs_combined,
    passed_runs: row.passed_runs_combined,
    failed_runs: row.failed_runs_combined,
    flaky_runs: row.flaky_runs_combined,
    skipped_runs: row.skipped_runs_combined,
    attempts: row.attempts_combined,
    pass_rate: row.pass_rate,
    failure_rate: row.failure_rate,
    flaky_rate: row.flaky_rate,
    skip_rate: row.skip_rate,
    mean_passed_duration_milliseconds:
      row.mean_passed_duration_milliseconds_combined,
    mean_duration_milliseconds: row.mean_duration_milliseconds_combined,
    total_duration_milliseconds: row.total_duration_milliseconds_combined,
    last_run_at: row.last_run_at_combined,
    last_failed_at: row.last_failed_at_combined,
  };
}

export function toConfigurationHealth(
  row: EntityRow,
  query: Pick<HealthSummary, "window" | "ran_on">
): TestConfigurationHealth {
  return {
    environment: row.environment_id_string === "0" ? null : toEnvironment(row),
    env_vars: row.env_var_set_id_string === "0" ? null : toEnvVars(row),
    health: toHealth(row, query),
  };
}

export function toEntry(
  row: EntityRow,
  query: Pick<HealthSummary, "window" | "ran_on">
): TestHealthEntry {
  const entry = {
    test: toTest(row),
    ...toConfigurationHealth(row, query),
    owners: row.owners,
  };
  return { ...entry, hud_url: testPageLinkForEntry(entry, query) };
}
