import { SeekKey, seekOrderBy, seekPredicate } from "lib/api/seek";
import { CI_DATABASE } from "lib/api/tests/database";
import {
  buildEnvVarFilters,
  searchPredicateSql,
} from "lib/api/tests/shared-sql";
import type { RunsCursor } from "lib/api/tests/test/runs/cursor";
import {
  RUN_FILTER_DEFINITIONS,
  RUN_LIST_PARAMETER_DEFINITIONS,
  RUN_SORT_FIELDS,
  RunsListQuery,
} from "lib/api/tests/test/runs/parameters";
import {
  WORKFLOW_PATH_SQL,
  workflowMetadataSql,
} from "lib/api/tests/test/runs/workflow-query";
import {
  BUNDLE_STATUSES,
  BundleStatus,
  FAILING_OUTCOMES,
  RunOutcome,
} from "lib/runOutcomes";

const SORT_COLUMNS = {
  started_at: "timestamp",
  ended_at: "timestamp",
  tests_id: "UInt64",
  environments_id: "UInt64",
  env_vars_id: "UInt64",
  github_workflow_job_id: "Int64",
  rerun_number: "UInt16",
  outcome: "String",
  duration_milliseconds: "Int64",
} as const;
type RunSortField =
  | keyof typeof SORT_COLUMNS
  | (typeof RUN_SORT_FIELDS)[number];
export interface RunSortKey {
  field: RunSortField;
  type: (typeof SORT_COLUMNS)[keyof typeof SORT_COLUMNS] | "UInt8";
  direction: "ASC" | "DESC";
  nullable?: boolean;
  expression?: string;
}

// A bundle is one test and configuration in one CI job, across reports.
// tests_id is fixed by the test route and joins the tie breakers for commits.
const IDENTITY_FIELDS: (keyof typeof SORT_COLUMNS)[] = [
  "environments_id",
  "env_vars_id",
  "github_workflow_job_id",
];
export const RUN_GROUP_FIELDS = [
  "tests_id",
  "environments_id",
  "env_vars_id",
  "github_workflow_job_id",
] as const;

// Versions of one run share its test start, so a start holding one stored row
// holds that run's only version. Pages and statistics resolve replacements by it.
export const RUN_START = "run.tests_id, run.started_at";

// A bundle's attempts in chronological order, as the attempts query and the
// mapping sort them. Timestamps have millisecond precision; the UUID string
// breaks the rare tie.
export const RUN_CHRONOLOGY = "run.started_at, run.ended_at, toString(run.id)";

// The outcome a bundle settled on: its chronologically last executed attempt's,
// or skipped when no attempt executed. A skip never overrides an executed
// attempt: a test that timed out or failed and was then skipped in its rerun
// did not recover, and the health view's retry chains count it as a failure
// too. The recorded last attempt alone would call such a bundle skipped.
export const FINAL_OUTCOME = `argMax(run.outcome, (run.outcome != 'skipped', ${RUN_CHRONOLOGY}))`;

const FAILING_OUTCOMES_SQL = `(${[...FAILING_OUTCOMES]
  .map((outcome) => `'${outcome}'`)
  .join(", ")})`;

// A bundle's status over its grouped attempts, the rule of BUNDLE_STATUSES in
// lib/runOutcomes.ts (bundleStatusOf in lib/tests/bundle.ts is the same rule
// for the pages): skipped when nothing executed; by the final outcome
// otherwise, a failure, error or crash failed, a timeout timed_out, a pass
// after a failing attempt flaky and without one passed, an expected failure
// xfailed, anything else other.
export const BUNDLE_STATUS_SQL = `multiIf(countIf(run.outcome != 'skipped') = 0, 'skipped', ${FINAL_OUTCOME} IN ('failed', 'error', 'crashed'), 'failed', ${FINAL_OUTCOME} = 'timed_out', 'timed_out', ${FINAL_OUTCOME} = 'passed', if(countIf(run.outcome IN ${FAILING_OUTCOMES_SQL}) > 0, 'flaky', 'passed'), ${FINAL_OUTCOME} = 'xfailed', 'xfailed', 'other')`;

// A bundle's executed time in milliseconds: each attempt's end less its start,
// never negative, skipped attempts left out.
export const BUNDLE_DURATION_SQL =
  "sum(if(run.outcome != 'skipped', greatest(0, toUnixTimestamp64Milli(run.ended_at) - toUnixTimestamp64Milli(run.started_at)), 0))";

// The stored outcomes a bundle of each status must hold a row of, after
// replacement deduplication: a failed bundle's final attempt failed, errored
// or crashed; a flaky bundle had a failing attempt; and so on. A key with no
// such row cannot have the status, so these prune a by_job read.
const STATUS_OUTCOMES: Record<BundleStatus, readonly RunOutcome[]> = {
  failed: ["failed", "error", "crashed"],
  timed_out: ["timed_out"],
  flaky: [...FAILING_OUTCOMES],
  passed: ["passed"],
  other: ["xpassed", "unknown"],
  xfailed: ["xfailed"],
  skipped: ["skipped"],
};

// The outcomes a key set drawn by prunes a by_job read: a failing outcome,
// an unexpected pass or an unknown. Passes and skips are most of a commit's
// rows, so a set drawn by them prunes nothing and costs a pass; expected
// failures, rare among rows, belong to thousands of tests on a main commit
// (10,443 of 672,763 on ce6ff46), each read whole from every part, 254K
// granules and 36 s on 2026-11-01 against 2.7 s for the grouped read.
const PRUNABLE_OUTCOMES: ReadonlySet<RunOutcome> = new Set<RunOutcome>([
  ...FAILING_OUTCOMES,
  "xpassed",
  "unknown",
]);

// The stored outcomes a bundle of any of the statuses must hold a row of.
function statusOutcomes(statuses: readonly BundleStatus[]): RunOutcome[] {
  return Array.from(
    new Set(statuses.flatMap((status) => STATUS_OUTCOMES[status]))
  ).sort();
}

// Whether a key set drawn by the outcomes prunes a by_job read.
function rare(outcomes: readonly RunOutcome[]): boolean {
  return outcomes.every((outcome) => PRUNABLE_OUTCOMES.has(outcome));
}

export interface RunStatusFilter {
  // Bundle statuses to select, the outcomes the commit page lists.
  status?: readonly BundleStatus[];
  // Bundle statuses a selected bundle's test must have as its worst over
  // every bundle of the test in the scope, as the commit summary counts
  // tests once.
  worst_status?: readonly BundleStatus[];
}

// The stored outcomes that every bundle a query's attempt filters can select
// must hold a row of, when they are rare enough to prune a by_job read by: the
// outcome filter's own values, else the last_attempt_outcome filter's (the
// final attempt's latest version holds that outcome), else the statuses'
// (STATUS_OUTCOMES), else the worst statuses' (a test whose worst status is
// one of them has a bundle of it). Undefined when no filter qualifies.
function candidateOutcomes(
  query: Pick<RunPageQuery, "outcome" | "last_attempt_outcome"> &
    RunStatusFilter
): RunOutcome[] | undefined {
  const candidates: (readonly RunOutcome[] | undefined)[] = [
    query.outcome,
    query.last_attempt_outcome,
    query.status === undefined ? undefined : statusOutcomes(query.status),
    query.worst_status === undefined
      ? undefined
      : statusOutcomes(query.worst_status),
  ];
  return candidates.find(
    (outcomes) => outcomes !== undefined && rare(outcomes)
  ) as RunOutcome[] | undefined;
}

const BUNDLE_STATUSES_SQL = `[${BUNDLE_STATUSES.map(
  (status) => `'${status}'`
).join(", ")}]`;

// The statuses best first, skipped through failed: the status sort's rank,
// so ascending is best first and -status puts the worst first, as the tests
// list's status sort does.
const STATUS_RANK_SQL = `[${[...BUNDLE_STATUSES]
  .reverse()
  .map((status) => `'${status}'`)
  .join(", ")}]`;

// A test's worst status over its bundles, each grouped row one bundle with
// its status: the first of BUNDLE_STATUSES any of them has, as the commit
// summary ranks them, found over the test's rows in one pass by a window.
const WORST_STATUS_SQL = `${BUNDLE_STATUSES_SQL}[min(indexOf(${BUNDLE_STATUSES_SQL}, status)) OVER (PARTITION BY tests_id)]`;

export function runSortKeys(
  query: Pick<RunsListQuery, "sort">,
  includeTestId = false
) {
  const keys: RunSortKey[] = query.sort.map((sort) => {
    const field = sort.replace(/^-/, "") as (typeof RUN_SORT_FIELDS)[number];
    if (!RUN_SORT_FIELDS.includes(field)) {
      throw new Error(`Unknown run sort field: ${field}`);
    }
    const direction = sort.startsWith("-") ? "DESC" : "ASC";
    if (field === "status") {
      // The bundle's status, a column of the grouped rows, ranked best
      // first: 1 for skipped through 7 for failed.
      return {
        field,
        type: "UInt8",
        direction,
        expression: `indexOf(${STATUS_RANK_SQL}, run.status)`,
      };
    }
    if (field === "workflow_path" || field === "job_name") {
      return {
        field,
        type: "String",
        direction,
        nullable: true,
        expression: `run_workflow.${field}`,
      };
    }
    if (field === "test_config") {
      return {
        field,
        type: "String",
        direction,
        nullable: true,
        expression:
          "if(run_env_vars.has_catalog = 1, run_env_vars.test_config, NULL)",
      };
    }
    if (field in RUN_FILTER_DEFINITIONS) {
      const definition =
        RUN_FILTER_DEFINITIONS[field as keyof typeof RUN_FILTER_DEFINITIONS];
      const alias =
        definition.target === "environment" ? "run_environment" : "run_test";
      const column = `${alias}.${definition.column}`;
      return {
        field,
        type: definition.type,
        direction,
        nullable: true,
        expression:
          field === "owner"
            ? "run_test.owner"
            : `if(${alias}.has_catalog = 1, ${
                field === "language" ? `toString(${column})` : column
              }, NULL)`,
      };
    }
    return {
      field,
      type: SORT_COLUMNS[field as keyof typeof SORT_COLUMNS],
      direction,
      ...(field === "outcome" ? { expression: "toString(run.outcome)" } : {}),
    };
  });
  for (const field of includeTestId
    ? (["tests_id", ...IDENTITY_FIELDS] as const)
    : IDENTITY_FIELDS) {
    if (!keys.some((key) => key.field === field)) {
      keys.push({ field, type: SORT_COLUMNS[field], direction: "ASC" });
    }
  }
  return keys;
}

const keyExpression = (key: RunSortKey) => key.expression ?? `run.${key.field}`;

// The cursor value and sort_N column of a sort key, given its value.
function sortValue(key: RunSortKey, value: string) {
  return `toString(${
    key.type === "timestamp" ? `toUnixTimestamp64Milli(${value})` : value
  })`;
}

// The seek keys of a page: each sort expression with its bound cursor type.
// Timestamps travel as Unix milliseconds in the cursor and are converted on
// the bound side, keeping the sort-key column bare for pruning.
function seekKeys(keys: RunSortKey[]): SeekKey[] {
  return keys.map((key) => ({
    column: keyExpression(key),
    parameterType: key.type === "timestamp" ? "Int64" : key.type,
    ...(key.type === "timestamp"
      ? {
          bind: (placeholder: string) =>
            `fromUnixTimestamp64Milli(${placeholder})`,
        }
      : {}),
    direction: key.direction,
    nullable: key.nullable ?? false,
  }));
}

type RunPageQuery = Omit<RunsListQuery, "test_id">;
type RunSelectionQuery = Omit<RunPageQuery, "sort" | "limit">;
export interface RunPageScope {
  params: Record<string, unknown>;
  // Replacement-key predicates that select the scope's runs.
  filters: string[];
  // A route-pinned test can read its catalog entry without scanning runs.
  testId?: string;
  prefix?: string;
  // Job-scoped discovery may use the runs table's by_job projection.
  byJob?: boolean;
}

// Reuse the list API's column and type registry. Request values are bound;
// only metadata from that registry can become SQL syntax.
export function catalogFilters(
  query: RunSelectionQuery,
  target: "test" | "owner" | "environment",
  alias: string,
  params: Record<string, unknown>
) {
  return Object.entries(RUN_FILTER_DEFINITIONS).flatMap(
    ([field, definition]) => {
      if (
        definition.target !== target ||
        field === "environments_id" ||
        field === "env_vars_id"
      ) {
        return [];
      }
      const value = query[field as keyof RunSelectionQuery];
      if (value === undefined) return [];
      const parameter = `filter_${field}`;
      params[parameter] = value;
      const column = `${alias}.${definition.column}`;
      const set = `{${parameter}: Array(${definition.type})}`;
      return [
        definition.match === "array"
          ? `hasAny(${column}, ${set})`
          : `${column} IN ${set}`,
      ];
    }
  );
}

function selectionJoins(
  query: RunSelectionQuery,
  scope: RunPageScope,
  keys: RunSortKey[],
  identityFilters: string[],
  filters: string[],
  params: Record<string, unknown>
) {
  const TEST_CONFIG_COLUMN = `env_var_set.${RUN_LIST_PARAMETER_DEFINITIONS.test_config.column}`;
  const joins: string[] = [];
  // These IDs are replacement-key columns. Reading without FINAL discovers
  // a safe superset. The actual records, including mutable outcomes, are
  // still deduplicated. IN removes duplicate IDs; a by_job scope must not ask
  // for DISTINCT, which reads tests_id in sorting-key order without by_job.
  const discover = (column: string) => `
        SELECT ${scope.byJob ? "" : "DISTINCT "}run.${column}
        FROM ${CI_DATABASE}.runs AS run
        WHERE ${[...scope.filters, ...identityFilters].join(
          "\n            AND "
        )}`;

  const testFilters = [
    ...catalogFilters(query, "test", "test", params),
    ...catalogFilters(query, "owner", "owner", params),
  ];
  if (query.search !== undefined) {
    params.search = query.search;
    testFilters.push(searchPredicateSql("test"));
  }
  const testSorts = keys.filter((key) => key.expression?.includes("run_test."));
  if (testFilters.length || testSorts.length) {
    const needsOwners =
      query.owner !== undefined ||
      testSorts.some((key) => key.field === "owner");
    const columns = testSorts.map((key) =>
      key.field === "owner"
        ? "if(empty(owner.owners), NULL, arraySort(owner.owners)[1]) AS owner"
        : `test.${key.field} AS ${key.field}`
    );
    const catalog = `
    SELECT test.id AS id${
      columns.length ? `, ${columns.join(", ")}, toUInt8(1) AS has_catalog` : ""
    }
    FROM ${CI_DATABASE}.tests AS test FINAL${
      needsOwners
        ? `
    LEFT JOIN (
        SELECT repo, file, owners FROM ${CI_DATABASE}.owners FINAL
    ) AS owner ON owner.repo = test.repo AND owner.file = test.file`
        : ""
    }
    WHERE ${
      scope.testId !== undefined
        ? "test.id = {test_id: UInt64}"
        : `test.id IN (${discover("tests_id")})`
    }${testFilters.map((filter) => `\n        AND ${filter}`).join("")}`;
    if (testSorts.length) {
      joins.push(
        `LEFT JOIN (${catalog}\n) AS run_test ON run_test.id = run.tests_id`
      );
      if (testFilters.length) filters.push("run_test.has_catalog = 1");
    } else {
      filters.push(`run.tests_id IN (${catalog}\n    )`);
    }
  }

  const environmentFilters = catalogFilters(
    query,
    "environment",
    "environment",
    params
  );
  const environmentSorts = keys.filter((key) =>
    key.expression?.includes("run_environment.")
  );
  if (environmentFilters.length || environmentSorts.length) {
    const columns = environmentSorts.map((key) => `environment.${key.field}`);
    const catalog = `
    SELECT environment.id AS id${
      columns.length ? `, ${columns.join(", ")}, toUInt8(1) AS has_catalog` : ""
    }
    FROM ${CI_DATABASE}.environments AS environment FINAL
    WHERE ${
      environmentFilters.length ? environmentFilters.join(" AND ") : "1"
    }`;
    if (environmentSorts.length) {
      joins.push(
        `LEFT JOIN (${catalog}\n) AS run_environment ON run_environment.id = run.environments_id`
      );
      if (environmentFilters.length)
        filters.push("run_environment.has_catalog = 1");
    } else {
      filters.push(`run.environments_id IN (${catalog}\n    )`);
    }
  }

  const envVarFilters = buildEnvVarFilters(query.env_vars, params);
  if (query.test_config !== undefined) {
    params.filter_test_config = query.test_config;
    envVarFilters.push(
      `${TEST_CONFIG_COLUMN} IN {filter_test_config: Array(String)}`
    );
  }
  const envVarSorts = keys.filter((key) =>
    key.expression?.includes("run_env_vars.")
  );
  if (envVarSorts.length) {
    joins.push(
      `LEFT JOIN (
    SELECT env_var_set.id AS id, ${TEST_CONFIG_COLUMN} AS test_config, toUInt8(1) AS has_catalog
    FROM ${CI_DATABASE}.env_vars AS env_var_set FINAL
    WHERE ${envVarFilters.length ? envVarFilters.join(" AND ") : "1"}
) AS run_env_vars ON run_env_vars.id = run.env_vars_id`
    );
    if (envVarFilters.length) filters.push("run_env_vars.has_catalog = 1");
  } else if (envVarFilters.length) {
    filters.push(`run.env_vars_id IN (
        SELECT id FROM ${CI_DATABASE}.env_vars AS env_var_set FINAL
        WHERE ${envVarFilters.join(" AND ")}
    )`);
  }

  const jobNameSorted = keys.some((key) => key.field === "job_name");
  if (
    query.workflow_path !== undefined ||
    keys.some((key) => key.field === "workflow_path") ||
    jobNameSorted
  ) {
    // Bound both metadata tables by jobs in this selection, through the lookup
    // page enrichment uses, so filters and sorting see the returned path.
    const workflow = workflowMetadataSql({
      jobIds: `(${discover("github_workflow_job_id")})`,
      jobColumns: jobNameSorted ? ["name"] : [],
      workflowColumns: ["path"],
      columns: [
        "job.id AS id",
        `${WORKFLOW_PATH_SQL} AS workflow_path`,
        ...(jobNameSorted ? ["nullIf(job.name, '') AS job_name"] : []),
      ],
    });
    joins.push(
      `LEFT JOIN (\n${workflow}\n) AS run_workflow ON run_workflow.id = run.github_workflow_job_id`
    );
    if (query.workflow_path !== undefined) {
      params.workflow_path = query.workflow_path;
      filters.push(
        "run_workflow.workflow_path IN {workflow_path: Array(String)}"
      );
    }
  }
  return joins.length ? `\n${joins.join("\n")}` : "";
}

// Configuration filters restrict the group. Attempt filters select a group
// only when one retained execution satisfies all of them; aggregation still
// includes every execution of that group.
function selectionFilters(
  query: RunSelectionQuery,
  scope: RunPageScope,
  keys: RunSortKey[],
  params: Record<string, unknown>
) {
  const identityFilters: string[] = [];
  for (const field of ["environments_id", "env_vars_id"] as const) {
    if (query[field] !== undefined) {
      params[field] = query[field];
      identityFilters.push(
        `run.${field} IN CAST({${field}: Array(String)}, 'Array(UInt64)')`
      );
    }
  }
  const attemptFilters: string[] = [];
  if (query.rerun_number !== undefined) {
    params.rerun_number = query.rerun_number;
    attemptFilters.push("run.rerun_number IN {rerun_number: Array(UInt16)}");
  }
  if (query.outcome !== undefined) {
    params.outcome = query.outcome;
    attemptFilters.push("run.outcome IN {outcome: Array(String)}");
  }
  const joinFilters: string[] = [];
  const joins = selectionJoins(
    query,
    scope,
    keys,
    identityFilters,
    joinFilters,
    params
  );
  return { identityFilters, attemptFilters, joinFilters, joins };
}

export function buildRunsQuery(
  query: RunsListQuery,
  cursor: RunsCursor | null
) {
  return buildRunPageQuery(query, cursor, {
    params: { test_id: query.test_id },
    filters: ["run.tests_id = {test_id: UInt64}"],
    testId: query.test_id,
  });
}

export const PAGE_COLUMNS = `run.id AS id,
    toString(run.tests_id) AS tests_id_string,
    toString(run.environments_id) AS environments_id_string,
    toString(run.env_vars_id) AS env_vars_id_string,
    toString(run.github_workflow_job_id) AS github_workflow_job_id_string,
    run.report_uuid AS report_uuid,
    run.rerun_number AS rerun_number,
    run.outcome AS outcome,
    run.outcome_summary AS outcome_summary,
    run.started_at AS started_at,
    run.ended_at AS ended_at`;

export function buildRunPageQuery(
  query: RunPageQuery & RunStatusFilter,
  cursor: Pick<RunsCursor, "position" | "direction"> | null,
  scope: RunPageScope,
  keys = runSortKeys(query)
) {
  const params: Record<string, unknown> = {
    ...scope.params,
    entries_limit: query.limit + 1,
  };
  // A by_job scope whose attempt filters admit only bundles holding a rare
  // outcome reads FINAL by primary key instead: one by_job pass finds the
  // tests that hold such a row on the commit, a superset of the tests the
  // filters select, and the deduplicated read is pruned to those tests'
  // key ranges, as a test's own page reads. A filtered commit page then
  // costs one pass and a few hundred thousand rows instead of the shared
  // start classification over the commit's hundreds of millions. A scalar
  // holding the keys was tried first: the old analyzer copies the WITH
  // clause into every subquery, and the nested evaluations took gigabytes.
  const candidates = scope.byJob ? candidateOutcomes(query) : undefined;
  if (candidates !== undefined) params.candidate_outcomes = candidates;
  const { identityFilters, attemptFilters, joinFilters, joins } =
    selectionFilters(query, scope, keys, params);
  // A worst_status filter ranks every bundle of a test on the commit, in any
  // job, so the grouped bundles carry their statuses and are ranked by a
  // window over the test's rows before anything selects among them: the
  // bundle filters, the identity filters among them, apply after the
  // ranking rather than in the source or the HAVING, as columns of the
  // grouped rows. Without the filter the grouped read is as before.
  const ranking = query.worst_status !== undefined;
  const runFilters = [...scope.filters, ...identityFilters];
  const seek = seekKeys(keys);
  const predicate = seekPredicate(seek, cursor, params);
  const chronology = `(${RUN_CHRONOLOGY})`;
  // The bundle filters: HAVING conditions of the grouping, or with ranking
  // columns of the grouped rows and conditions on them after the window.
  const groupFilters: string[] = [];
  const rankedColumns: string[] = [];
  const rankedFilters: string[] = [];
  const bundleFilter = (
    aggregate: string,
    column: string,
    condition: (_value: string) => string
  ) => {
    if (ranking) {
      rankedColumns.push(`${aggregate} AS ${column}`);
      rankedFilters.push(condition(`run.${column}`));
    } else {
      groupFilters.push(condition(aggregate));
    }
  };
  if (attemptFilters.length) {
    bundleFilter(
      `countIf(${attemptFilters.join(" AND ")}) > 0`,
      "attempt_matched",
      (value) => value
    );
  }
  if (query.last_attempt_outcome !== undefined) {
    params.last_attempt_outcome = query.last_attempt_outcome;
    // Choose the last retained execution from the complete group, independently
    // of which execution satisfies the outcome and rerun-number filters.
    bundleFilter(
      `argMax(run.outcome, ${chronology})`,
      "last_outcome",
      (value) => `${value} IN {last_attempt_outcome: Array(String)}`
    );
  }
  if (query.status !== undefined) {
    params.status = query.status;
    bundleFilter(
      BUNDLE_STATUS_SQL,
      "status",
      (value) => `${value} IN {status: Array(String)}`
    );
  } else if (ranking) {
    rankedColumns.push(`${BUNDLE_STATUS_SQL} AS status`);
  }
  if (query.worst_status !== undefined) {
    params.worst_status = query.worst_status;
    rankedFilters.push("run.worst_status IN {worst_status: Array(String)}");
  }
  const aggregates = keys.flatMap((key) => {
    if (key.field === "started_at")
      return ["min(run.started_at) AS started_at"];
    if (key.field === "ended_at") return ["max(run.ended_at) AS ended_at"];
    if (key.field === "outcome" || key.field === "rerun_number") {
      return [`argMax(run.${key.field}, ${chronology}) AS ${key.field}`];
    }
    if (key.field === "duration_milliseconds") {
      return [`${BUNDLE_DURATION_SQL} AS duration_milliseconds`];
    }
    // A status sort reads the status rule as a column; with ranking the
    // grouped rows carry it already.
    if (key.field === "status") {
      return ranking ? [] : [`${BUNDLE_STATUS_SQL} AS status`];
    }
    return [];
  });
  // Group keys and each attempt's start are replacement-key columns. Without
  // mutable filters/sorts, duplicate versions cannot change group membership,
  // min(started_at), or whether a rerun-number predicate matches. Reading the
  // by_job projection directly is then equivalent to grouping after FINAL.
  // Any mutable selection/order requires the deduplicated read: a route-pinned
  // test reads FINAL by primary key; a by_job scope, whose job filter prunes
  // nothing under FINAL, reads FINAL only at the test starts that hold more
  // than one stored row and the rest directly, as the statistics do for the
  // job and test keys they must group.
  const useProjection =
    scope.byJob &&
    query.outcome === undefined &&
    query.last_attempt_outcome === undefined &&
    query.status === undefined &&
    query.worst_status === undefined &&
    !keys.some((key) =>
      [
        "ended_at",
        "outcome",
        "status",
        "rerun_number",
        "duration_milliseconds",
      ].includes(key.field)
    );
  const pruned = scope.byJob && !useProjection && candidates !== undefined;
  const classify = scope.byJob && !useProjection && !pruned;
  // With ranking the source holds every bundle of the scope's tests, the
  // identity filters applying after the window.
  const where = `WHERE ${(ranking ? scope.filters : runFilters).join(
    "\n        AND "
  )}`;
  const grouped = `SELECT ${[
    ...RUN_GROUP_FIELDS.map((field) => `run.${field} AS ${field}`),
    ...aggregates,
    ...rankedColumns,
  ].join(",\n        ")}
    FROM ${
      classify
        ? classifiedRunsSource(where, attemptColumns(query, keys))
        : pruned
        ? prunedRunsSource(scope, where, "candidate_outcomes")
        : `${CI_DATABASE}.runs AS run${
            useProjection ? "" : " FINAL"
          }\n    ${where}`
    }
    GROUP BY ${RUN_GROUP_FIELDS.map((field) => `run.${field}`).join(", ")}
    ${
      groupFilters.length ? `HAVING ${groupFilters.join("\n        AND ")}` : ""
    }`;
  // The grouped rows ranked: each with its test's worst status beside it.
  const ranked = `SELECT ${[
    ...RUN_GROUP_FIELDS,
    ...[...aggregates, ...rankedColumns].map((column) =>
      column.slice(column.lastIndexOf(" AS ") + " AS ".length)
    ),
  ].join(", ")},
        ${WORST_STATUS_SQL} AS worst_status
    FROM (
    ${grouped}
    )`;
  const outerFilters = [
    ...(ranking ? [...identityFilters, ...rankedFilters] : []),
    ...joinFilters,
  ];
  return {
    params,
    // Attempt predicates are HAVING conditions so a matching failure keeps
    // its later success. Returned executions are always fetched with FINAL.
    // Catalog and workflow values are constant within a group's foreign keys.
    sql: `${scope.prefix ?? ""}
SELECT
    ${RUN_GROUP_FIELDS.map(
      (field) => `toString(run.${field}) AS ${field}_string`
    ).join(",\n    ")},
    ${keys
      .map(
        (key, index) => `${sortValue(key, keyExpression(key))} AS sort_${index}`
      )
      .join(",\n    ")}
FROM (
    ${ranking ? ranked : grouped}
) AS run${joins}
WHERE ${outerFilters.length ? outerFilters.join("\n    AND ") : "1"}
    AND (${predicate})
ORDER BY ${seekOrderBy(seek, cursor?.direction === "previous")}
LIMIT {entries_limit: UInt64}
SETTINGS optimize_move_to_prewhere_if_final = 0
`,
  };
}

// Starts a WITH clause after the scope's prefix, which may already open one.
export function withClause(scope: Pick<RunPageScope, "prefix">) {
  return scope.prefix ? `${scope.prefix},` : "\nWITH";
}

// The test starts among the scope's runs that hold more than one stored row.
// Versions of one run share its replacement key, so they share a start; a
// start with one stored row holds that run's only version. The scope's
// filters are key columns and cannot separate versions. Inlined rather than
// a WITH scalar: the old analyzer copies the WITH clause into every nested
// subquery, and a scalar holding this text overflows the AST size limit.
// Both membership tests below carry the same text, so one set serves both.
export function sharedStartsSubquery(where: string) {
  return `SELECT ${RUN_START}
            FROM ${CI_DATABASE}.runs AS run
            ${where}
            GROUP BY ${RUN_START}
            HAVING count() > 1`;
}

// The scope's rows read through FINAL, pruned by primary key to the tests
// holding a row of the outcomes bound as the named parameter, found in one
// by_job pass: a superset of the tests the filters select, and complete for
// each, since FINAL resolves replacements within a test's rows, which the
// pruning keeps whole. tests_id leads the primary key, so the read keeps
// the candidate tests' granules alone (query-validation.md, 2026-10-30).
export function prunedRunsSource(
  scope: Pick<RunPageScope, "filters">,
  where: string,
  outcomesParameter: string
) {
  return `${CI_DATABASE}.runs AS run FINAL
    PREWHERE run.tests_id IN (SELECT run.tests_id
        FROM ${CI_DATABASE}.runs AS run
        WHERE ${scope.filters.join("\n            AND ")}
            AND run.outcome IN {${outcomesParameter}: Array(String)}
        GROUP BY run.tests_id)
    ${where}`;
}

// The scope's runs as FINAL would return them: rows at unique starts read
// directly through by_job, rows at shared starts deduplicated by a FINAL
// read pruned to those starts. Only the columns the grouping uses are read.
export function classifiedRunsSource(where: string, columns: string[]) {
  const select = `SELECT ${[...RUN_GROUP_FIELDS, ...columns]
    .map((field) => `run.${field} AS ${field}`)
    .join(", ")}`;
  const sharedStarts = sharedStartsSubquery(where);
  return `(
        ${select}
        FROM ${CI_DATABASE}.runs AS run
        ${where}
            AND (${RUN_START}) NOT IN (${sharedStarts})
        UNION ALL
        ${select}
        FROM ${CI_DATABASE}.runs AS run FINAL
        PREWHERE (${RUN_START}) IN (${sharedStarts})
        ${where}
    ) AS run`;
}

// The attempt columns the grouped page reads besides its group keys: the
// sort aggregates, the attempt filters, and the chronology argMax orders by.
function attemptColumns(
  query: RunPageQuery & RunStatusFilter,
  keys: RunSortKey[]
) {
  const sorted = (field: RunSortField) =>
    keys.some((key) => key.field === field);
  // The status rule, a filter's or a sort's, reads every attempt's outcome
  // and the chronology.
  const status =
    query.status !== undefined ||
    query.worst_status !== undefined ||
    sorted("status");
  const chronology =
    query.last_attempt_outcome !== undefined ||
    status ||
    sorted("outcome") ||
    sorted("rerun_number");
  return [
    ...(chronology || sorted("started_at") || sorted("duration_milliseconds")
      ? ["started_at"]
      : []),
    ...(chronology || sorted("ended_at") || sorted("duration_milliseconds")
      ? ["ended_at"]
      : []),
    ...(chronology ? ["id"] : []),
    ...(query.outcome !== undefined ||
    query.last_attempt_outcome !== undefined ||
    status ||
    sorted("outcome") ||
    sorted("duration_milliseconds")
      ? ["outcome"]
      : []),
    ...(query.rerun_number !== undefined || sorted("rerun_number")
      ? ["rerun_number"]
      : []),
  ];
}
