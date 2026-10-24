import { CI_DATABASE } from "lib/api/tests/database";
import { SEARCH_FIELDS } from "lib/api/tests/parameters";
import { buildEnvVarFilters } from "lib/api/tests/shared-sql";
import type { RunsCursor } from "lib/api/tests/test/runs/cursor";
import {
  RUN_FILTER_DEFINITIONS,
  RUN_SORT_FIELDS,
  RunsListQuery,
} from "lib/api/tests/test/runs/parameters";
import { RUN_OUTCOMES } from "lib/api/tests/test/runs/types";
import {
  WORKFLOW_PATH_SQL,
  workflowMetadataSql,
} from "lib/api/tests/test/runs/workflow-query";

const SORT_COLUMNS = {
  started_at: "timestamp",
  ended_at: "timestamp",
  tests_id: "UInt64",
  environments_id: "UInt64",
  env_vars_id: "UInt64",
  github_workflow_job_id: "Int64",
  rerun_number: "UInt16",
  outcome: "String",
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

// Statistics retain their existing exact replacement resolution by test start.
const RUN_START = "run.tests_id, run.started_at";

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
    if (field === "workflow_path") {
      return {
        field,
        type: "String",
        direction,
        nullable: true,
        expression: "run_workflow.workflow_path",
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

function afterCursor(
  keys: ReturnType<typeof runSortKeys>,
  cursor: Pick<RunsCursor, "position"> | null,
  params: Record<string, unknown>
): string {
  if (cursor === null) return "1";
  const prefix: string[] = [];
  const alternatives: string[] = [];
  keys.forEach((key, index) => {
    const column = key.expression ?? `run.${key.field}`;
    const value = cursor.position.values[index];
    if (value === null) {
      prefix.push(`isNull(${column})`);
      return;
    }
    const parameter = `cursor_${index}`;
    params[parameter] = value;
    // Convert the bound value, keeping the sort-key column bare for pruning.
    const bound =
      key.type === "timestamp"
        ? `fromUnixTimestamp64Milli({${parameter}: Int64})`
        : `{${parameter}: ${key.type}}`;
    const comparison = `${column} ${
      key.direction === "DESC" ? "<" : ">"
    } ${bound}`;
    alternatives.push(
      `(${[
        ...prefix,
        key.nullable ? `(${comparison} OR isNull(${column}))` : comparison,
      ].join(" AND ")})`
    );
    prefix.push(`${column} = ${bound}`);
  });
  return alternatives.length === 0 ? "0" : alternatives.join(" OR ");
}

const keyExpression = (key: RunSortKey) => key.expression ?? `run.${key.field}`;

// The cursor value and sort_N column of a sort key, given its value.
function sortValue(key: RunSortKey, value: string) {
  return `toString(${
    key.type === "timestamp" ? `toUnixTimestamp64Milli(${value})` : value
  })`;
}

function orderBy(
  keys: RunSortKey[],
  value: (_key: RunSortKey, _index: number) => string
) {
  return keys
    .map(
      (key, index) =>
        `${value(key, index)} ${key.direction}${
          key.nullable ? " NULLS LAST" : ""
        }`
    )
    .join(", ");
}

type RunPageQuery = Omit<RunsListQuery, "test_id">;
type RunSelectionQuery = Omit<RunPageQuery, "sort" | "limit">;
interface RunPageScope {
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
function catalogFilters(
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
    testFilters.push(
      `(${SEARCH_FIELDS.map((field) => `test.${field} = {search: String}`).join(
        " OR "
      )})`
    );
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
  if (envVarFilters.length) {
    filters.push(`run.env_vars_id IN (
        SELECT id FROM ${CI_DATABASE}.env_vars AS env_var_set FINAL
        WHERE ${envVarFilters.join(" AND ")}
    )`);
  }

  if (
    query.workflow_path !== undefined ||
    keys.some((key) => key.field === "workflow_path")
  ) {
    // Bound both metadata tables by jobs in this selection, through the lookup
    // page enrichment uses, so filters and sorting see the returned path.
    const workflow = workflowMetadataSql({
      jobIds: `(${discover("github_workflow_job_id")})`,
      jobColumns: [],
      workflowColumns: ["path"],
      columns: ["job.id AS id", `${WORKFLOW_PATH_SQL} AS workflow_path`],
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

// A FINAL read of the runs at the test starts in `starts`, restricted by
// `filters`. tests_id prunes the primary key. Filters on key columns cannot
// split the versions of a run, and the rest apply after FINAL.
function finalRunsByStart(starts: string, filters: string[]) {
  return `${CI_DATABASE}.runs AS run FINAL
    PREWHERE (${RUN_START}) IN (SELECT arrayJoin(${starts}))
    WHERE ${filters.join("\n        AND ")}`;
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
  query: RunPageQuery,
  cursor: Pick<RunsCursor, "position"> | null,
  scope: RunPageScope,
  keys = runSortKeys(query)
) {
  const params: Record<string, unknown> = {
    ...scope.params,
    entries_limit: query.limit + 1,
  };
  const { identityFilters, attemptFilters, joinFilters, joins } =
    selectionFilters(query, scope, keys, params);
  const runFilters = [...scope.filters, ...identityFilters];
  const predicate = afterCursor(keys, cursor, params);
  const chronology = "(run.started_at, run.ended_at, toString(run.id))";
  const aggregates = keys.flatMap((key) => {
    if (key.field === "started_at")
      return ["min(run.started_at) AS started_at"];
    if (key.field === "ended_at") return ["max(run.ended_at) AS ended_at"];
    if (key.field === "outcome" || key.field === "rerun_number") {
      return [`argMax(run.${key.field}, ${chronology}) AS ${key.field}`];
    }
    return [];
  });
  // Group keys and each attempt's start are replacement-key columns. Without
  // mutable filters/sorts, duplicate versions cannot change group membership,
  // min(started_at), or whether a rerun-number predicate matches. Reading the
  // by_job projection directly is then equivalent to grouping after FINAL.
  // Any mutable selection/order requires the deduplicated read.
  const useProjection =
    scope.byJob &&
    query.outcome === undefined &&
    !keys.some((key) =>
      ["ended_at", "outcome", "rerun_number"].includes(key.field)
    );
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
    SELECT ${[
      ...RUN_GROUP_FIELDS.map((field) => `run.${field} AS ${field}`),
      ...aggregates,
    ].join(",\n        ")}
    FROM ${CI_DATABASE}.runs AS run${useProjection ? "" : " FINAL"}
    WHERE ${runFilters.join("\n        AND ")}
    GROUP BY ${RUN_GROUP_FIELDS.map((field) => `run.${field}`).join(", ")}
    ${
      attemptFilters.length
        ? `HAVING countIf(${attemptFilters.join(" AND ")}) > 0`
        : ""
    }
) AS run${joins}
WHERE ${joinFilters.length ? joinFilters.join("\n    AND ") : "1"}
    AND (${predicate})
ORDER BY ${orderBy(keys, keyExpression)}
LIMIT {entries_limit: UInt64}
SETTINGS optimize_move_to_prewhere_if_final = 0
`,
  };
}

// Starts a WITH clause after the scope's prefix, which may already open one.
function withClause(scope: RunPageScope) {
  return scope.prefix ? `${scope.prefix},` : "\nWITH";
}

// Counts a by_job scope's runs, independently of page filters, ordering or
// pagination. One pass classifies the runs by test start: a start holding one
// stored run is counted from that pass, and the runs at other starts are
// counted after FINAL. Both come from the same pass, so no run is counted twice.
export function buildRunStatsQuery(scope: RunPageScope) {
  return {
    params: { ...scope.params },
    // classified_runs is an array of one tuple because the server materializes
    // a tuple-typed scalar as one value, which cannot hold over 1,000,000
    // starts. Tuple positions: the starts holding more than one run; the runs
    // at other starts, in total and then per outcome in RUN_OUTCOMES order.
    sql: `${withClause(scope)}
(
    SELECT [(
        groupArrayIf(test_start, stored_runs > 1),
        [
            countIf(stored_runs = 1),
            ${RUN_OUTCOMES.map(
              (outcome) => `countIf(stored_runs = 1 AND outcome = '${outcome}')`
            ).join(",\n            ")}
        ]
    )]
    FROM (
        SELECT (${RUN_START}) AS test_start,
            count() AS stored_runs,
            any(run.outcome) AS outcome
        FROM ${CI_DATABASE}.runs AS run
        WHERE ${scope.filters.join("\n            AND ")}
        GROUP BY ${RUN_START}
    )
) AS classified_runs,
(SELECT tupleElement(arrayJoin(classified_runs), 1)) AS shared_starts,
(SELECT tupleElement(arrayJoin(classified_runs), 2)) AS stored_once
SELECT stored_once[1] + count() AS total,
    ${RUN_OUTCOMES.map(
      (outcome, index) =>
        `stored_once[${
          index + 2
        }] + countIf(run.outcome = '${outcome}') AS ${outcome}`
    ).join(",\n    ")}
FROM ${finalRunsByStart("shared_starts", scope.filters)}
SETTINGS optimize_move_to_prewhere_if_final = 0
`,
  };
}
