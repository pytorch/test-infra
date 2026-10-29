import { CI_DATABASE } from "lib/api/tests/database";

// A test's name as pytest spells it, "file::suite::case_name", or
// "file::case_name" for a module-level function, from the catalog row with
// the given alias.
export function testNameSql(alias: string): string {
  return `if(${alias}.suite = '', concat(${alias}.file, '::', ${alias}.case_name), concat(${alias}.file, '::', ${alias}.suite, '::', ${alias}.case_name))`;
}

// The search parameter's predicate: the bound text occurs anywhere in the
// test's name, ignoring ASCII case, so what the name shows is what a search
// finds, a pasted node id included. Shared by every endpoint that searches.
export function searchPredicateSql(alias: string): string {
  return `positionCaseInsensitive(${testNameSql(alias)}, {search: String}) > 0`;
}

export function buildEnvVarFilters(
  envVars: Record<string, string[]> | undefined,
  params: Record<string, unknown>
) {
  return Object.entries(envVars ?? {}).map(([name, values], index) => {
    params[`env_var_name_${index}`] = name;
    params[`env_var_values_${index}`] = values;
    // A missing map key must not match a requested empty value.
    return `(mapContains(env_var_set.env_vars, {env_var_name_${index}: String})
        AND env_var_set.env_vars[{env_var_name_${index}: String}] IN {env_var_values_${index}: Array(String)})`;
  });
}

// Shared projections preserve the list and detail endpoints' catalog and health semantics.
// Counts and duration totals are additive. Rates and means are calculated
// after combining all matching configurations and sources. The passed mean
// remains approximate because the stored per-configuration means are rounded.
// Atomic health refreshes give every row the same refreshed_at, so any()
// preserves the exact generation read with the aggregated metrics.
// Workflow paths are a sorted set union across the selected sources.
// The status reads the combined counts: failing when a run's last attempt
// failed (failed_runs counts every run with a failing attempt and
// flaky_runs those that passed on retry, so the difference is the runs that
// stayed failed), flaky when every failing run passed on retry, healthy when
// no run failed, and skipped when there are no runs. The health view has a
// row only for a configuration with attempts or skips in the window, so no
// runs means every attempt was skipped (a row of retries alone, of a run
// started before the window, would read the same; live on 2026-10-25 no
// window had one). The rank orders the statuses that have runs, healthy 0,
// flaky 1, failing 2, so that descending puts the worst first; skipped has
// no rank and sorts last either way, as its rates do. Measured live on
// 2026-10-25 (7d, main, default page, four alternating rounds), the two
// expressions cost nothing the run-to-run noise could tell apart, as a
// String or as an Enum8.
// Aggregation in the health table's identity order bounds the group states.
export const COMBINED_HEALTH_SQL = `
        arraySort(arrayDistinct(groupArrayArray(workflow_paths))) AS workflow_paths_combined,
        sum(runs) AS runs_combined,
        sum(passed_runs) AS passed_runs_combined,
        sum(failed_runs) AS failed_runs_combined,
        sum(flaky_runs) AS flaky_runs_combined,
        sum(skipped_runs) AS skipped_runs_combined,
        sum(attempts) AS attempts_combined,
        if(
            passed_runs_combined > 0,
            toUInt32(intDiv(
                sum(mean_passed_duration_milliseconds * passed_runs)
                    + intDiv(passed_runs_combined, 2),
                greatest(passed_runs_combined, 1)
            )),
            NULL
        ) AS mean_passed_duration_milliseconds_combined,
        sum(total_duration_milliseconds) AS total_duration_milliseconds_combined,
        if(
            attempts_combined > 0,
            toUInt32(intDiv(
                total_duration_milliseconds_combined + intDiv(attempts_combined, 2),
                greatest(attempts_combined, 1)
            )),
            NULL
        ) AS mean_duration_milliseconds_combined,
        max(last_run_at) AS last_run_at_combined,
        max(last_failed_at) AS last_failed_at_combined,
        passed_runs_combined / nullIf(runs_combined, 0) AS pass_rate,
        failed_runs_combined / nullIf(runs_combined, 0) AS failure_rate,
        flaky_runs_combined / nullIf(runs_combined, 0) AS flaky_rate,
        skipped_runs_combined / nullIf(runs_combined + skipped_runs_combined, 0) AS skip_rate,
        multiIf(
            runs_combined = 0, 'skipped',
            failed_runs_combined > flaky_runs_combined, 'failing',
            failed_runs_combined > 0, 'flaky',
            'healthy'
        ) AS status,
        if(
            runs_combined = 0,
            NULL,
            toUInt64(multiIf(
                failed_runs_combined > flaky_runs_combined, 2,
                failed_runs_combined > 0, 1,
                0
            ))
        ) AS status_rank,
        any(refreshed_at) AS refreshed_at,
        toUInt8(1) AS has_health`;

const HEALTH_COLUMNS = [
  "runs_combined",
  "passed_runs_combined",
  "failed_runs_combined",
  "flaky_runs_combined",
  "skipped_runs_combined",
  "attempts_combined",
  "mean_passed_duration_milliseconds_combined",
  "mean_duration_milliseconds_combined",
  "total_duration_milliseconds_combined",
  "last_run_at_combined",
  "last_failed_at_combined",
  "pass_rate",
  "failure_rate",
  "flaky_rate",
  "skip_rate",
  "status",
  "status_rank",
] as const;

export const TEST_CATALOG_COLUMNS_SQL = `        test.id AS tests_id,
        test.repo AS repo,
        test.file AS file,
        test.suite AS suite,
        test.case_name AS case_name,
        test.declared_case_name AS declared_case_name,
        test.language AS language,
        test.first_seen_at AS first_seen_at,
        owner.owners AS owners`;

export const TEST_RESULT_COLUMNS_SQL = `            catalog.tests_id AS tests_id,
            catalog.repo AS repo,
            catalog.file AS file,
            catalog.suite AS suite,
            catalog.case_name AS case_name,
            catalog.declared_case_name AS declared_case_name,
            catalog.language AS language,
            catalog.first_seen_at AS first_seen_at,
            catalog.owners AS owners,
            toString(catalog.tests_id) AS tests_id_string,`;

export const CONFIGURATION_COLUMNS_SQL = `            health.environments_id AS environments_id,
            health.env_vars_id AS env_vars_id,
            toString(health.environments_id) AS environments_id_string,
            toString(health.env_vars_id) AS env_vars_id_string,
            toString(environment.id) AS environment_id_string,
            environment.os AS os,
            environment.os_version AS os_version,
            environment.cpu_architecture AS cpu_architecture,
            environment.cpu_capability AS cpu_capability,
            environment.python_version AS python_version,
            environment.cc_compiler AS cc_compiler,
            environment.cc_compiler_version AS cc_compiler_version,
            environment.accelerator AS accelerator,
            environment.accelerator_version AS accelerator_version,
            environment.device_name AS device_name,
            environment.device_count AS device_count,
            environment.first_seen_at AS environment_first_seen_at,
            toString(env_var_set.id) AS env_var_set_id_string,
            env_var_set.env_vars AS env_vars,
            env_var_set.first_seen_at AS env_vars_first_seen_at`;

export const CONFIGURATION_JOINS_SQL = `        LEFT JOIN (
            SELECT id, os, os_version, cpu_architecture, cpu_capability, python_version,
                cc_compiler, cc_compiler_version, accelerator, accelerator_version,
                device_name, device_count, first_seen_at
            FROM ${CI_DATABASE}.environments FINAL
        ) AS environment ON environment.id = health.environments_id
        LEFT JOIN (
            SELECT id, env_vars, first_seen_at FROM ${CI_DATABASE}.env_vars FINAL
        ) AS env_var_set ON env_var_set.id = health.env_vars_id`;

export const HEALTH_RESULT_COLUMNS_SQL = HEALTH_COLUMNS.map(
  (column) => `if(health.has_health = 1, health.${column}, NULL) AS ${column}`
).join(",\n        ");
