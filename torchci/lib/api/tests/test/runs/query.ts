import { SeekKey, seekOrderBy, seekPredicate } from "lib/api/seek";
import { CI_DATABASE } from "lib/api/tests/database";
import {
  buildEnvVarFilters,
  searchPredicateSql,
} from "lib/api/tests/shared-sql";
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

// Versions of one run share its test start, so a start holding one stored row
// holds that run's only version. Pages and statistics resolve replacements by it.
const RUN_START = "run.tests_id, run.started_at";

// A bundle's attempts in chronological order, as the attempts query and the
// mapping sort them. Timestamps have millisecond precision; the UUID string
// breaks the rare tie.
const RUN_CHRONOLOGY = "run.started_at, run.ended_at, toString(run.id)";

// The outcome a bundle settled on: its chronologically last executed attempt's,
// or skipped when no attempt executed. A skip never overrides an executed
// attempt: a test that timed out or failed and was then skipped in its rerun
// did not recover, and the health view's retry chains count it as a failure
// too. The recorded last attempt alone would call such a bundle skipped.
export const FINAL_OUTCOME = `argMax(run.outcome, (run.outcome != 'skipped', ${RUN_CHRONOLOGY}))`;

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
  cursor: Pick<RunsCursor, "position" | "direction"> | null,
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
  const seek = seekKeys(keys);
  const predicate = seekPredicate(seek, cursor, params);
  const chronology = `(${RUN_CHRONOLOGY})`;
  const groupFilters = attemptFilters.length
    ? [`countIf(${attemptFilters.join(" AND ")}) > 0`]
    : [];
  if (query.last_attempt_outcome !== undefined) {
    params.last_attempt_outcome = query.last_attempt_outcome;
    // Choose the last retained execution from the complete group, independently
    // of which execution satisfies the outcome and rerun-number filters.
    groupFilters.push(
      `argMax(run.outcome, ${chronology}) IN {last_attempt_outcome: Array(String)}`
    );
  }
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
  // Any mutable selection/order requires the deduplicated read: a route-pinned
  // test reads FINAL by primary key; a by_job scope, whose job filter prunes
  // nothing under FINAL, reads FINAL only at the test starts that hold more
  // than one stored row and the rest directly, as the statistics do for the
  // job and test keys they must group.
  const useProjection =
    scope.byJob &&
    query.outcome === undefined &&
    query.last_attempt_outcome === undefined &&
    !keys.some((key) =>
      ["ended_at", "outcome", "rerun_number"].includes(key.field)
    );
  const classify = scope.byJob && !useProjection;
  const where = `WHERE ${runFilters.join("\n        AND ")}`;
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
    FROM ${
      classify
        ? classifiedRunsSource(where, attemptColumns(query, keys))
        : `${CI_DATABASE}.runs AS run${
            useProjection ? "" : " FINAL"
          }\n    ${where}`
    }
    GROUP BY ${RUN_GROUP_FIELDS.map((field) => `run.${field}`).join(", ")}
    ${
      groupFilters.length ? `HAVING ${groupFilters.join("\n        AND ")}` : ""
    }
) AS run${joins}
WHERE ${joinFilters.length ? joinFilters.join("\n    AND ") : "1"}
    AND (${predicate})
ORDER BY ${seekOrderBy(seek, cursor?.direction === "previous")}
LIMIT {entries_limit: UInt64}
SETTINGS optimize_move_to_prewhere_if_final = 0
`,
  };
}

// Starts a WITH clause after the scope's prefix, which may already open one.
function withClause(scope: RunPageScope) {
  return scope.prefix ? `${scope.prefix},` : "\nWITH";
}

// The test starts among the scope's runs that hold more than one stored row.
// Versions of one run share its replacement key, so they share a start; a
// start with one stored row holds that run's only version. The scope's
// filters are key columns and cannot separate versions. Inlined rather than
// a WITH scalar: the old analyzer copies the WITH clause into every nested
// subquery, and a scalar holding this text overflows the AST size limit.
// Both membership tests below carry the same text, so one set serves both.
function sharedStartsSubquery(where: string) {
  return `SELECT ${RUN_START}
            FROM ${CI_DATABASE}.runs AS run
            ${where}
            GROUP BY ${RUN_START}
            HAVING count() > 1`;
}

// The scope's runs as FINAL would return them: rows at unique starts read
// directly through by_job, rows at shared starts deduplicated by a FINAL
// read pruned to those starts. Only the columns the grouping uses are read.
function classifiedRunsSource(where: string, columns: string[]) {
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
function attemptColumns(query: RunPageQuery, keys: RunSortKey[]) {
  const sorted = (field: RunSortField) =>
    keys.some((key) => key.field === field);
  const chronology =
    query.last_attempt_outcome !== undefined ||
    sorted("outcome") ||
    sorted("rerun_number");
  return [
    ...(chronology || sorted("started_at") ? ["started_at"] : []),
    ...(chronology || sorted("ended_at") ? ["ended_at"] : []),
    ...(chronology ? ["id"] : []),
    ...(query.outcome !== undefined ||
    query.last_attempt_outcome !== undefined ||
    sorted("outcome")
      ? ["outcome"]
      : []),
    ...(query.rerun_number !== undefined || sorted("rerun_number")
      ? ["rerun_number"]
      : []),
  ];
}

// Counts a by_job scope's bundles by final outcome, independently of page
// filters, ordering or pagination. A bundle lies within one job and test, so
// one by_job pass groups the scope's stored rows by that key. A key holding one
// stored row is a one-attempt bundle in its only version and is counted from
// that pass. The rows of the other keys, pruned by key on by_job, are read as
// FINAL would return them and grouped into bundles. The keys partition the
// rows, so no bundle is counted twice.
export function buildRunStatsQuery(scope: RunPageScope) {
  const where = `WHERE ${scope.filters.join("\n            AND ")}`;
  const multiRowWhere = `${where}
            AND (run.github_workflow_job_id, run.tests_id) IN (SELECT arrayJoin(multi_row_keys))`;
  const columns = [
    ...RUN_GROUP_FIELDS,
    "started_at",
    "ended_at",
    "id",
    "outcome",
  ];
  return {
    params: { ...scope.params },
    // classified_keys is an array of one tuple because the server materializes
    // a tuple-typed scalar as one value, which cannot hold over 1,000,000
    // keys. Tuple positions: the keys holding more than one stored row; the
    // keys holding one, in total and then per outcome in RUN_OUTCOMES order.
    // The direct branch below groups the remaining rows by test start and
    // keeps the starts holding one stored row, that run's only version, which
    // any() returns unchanged; the FINAL branch deduplicates the other starts.
    sql: `${withClause(scope)}
(
    SELECT [(
        groupArrayIf(job_test, stored_rows > 1),
        [
            countIf(stored_rows = 1),
            ${RUN_OUTCOMES.map(
              (outcome) => `countIf(stored_rows = 1 AND outcome = '${outcome}')`
            ).join(",\n            ")}
        ]
    )]
    FROM (
        SELECT (run.github_workflow_job_id, run.tests_id) AS job_test,
            count() AS stored_rows,
            any(run.outcome) AS outcome
        FROM ${CI_DATABASE}.runs AS run
        ${where}
        GROUP BY run.github_workflow_job_id, run.tests_id
    )
) AS classified_keys,
(SELECT tupleElement(arrayJoin(classified_keys), 1)) AS multi_row_keys,
(SELECT tupleElement(arrayJoin(classified_keys), 2)) AS stored_once
SELECT stored_once[1] + count() AS total,
    ${RUN_OUTCOMES.map(
      (outcome, index) =>
        `stored_once[${
          index + 2
        }] + countIf(final_outcome = '${outcome}') AS ${outcome}`
    ).join(",\n    ")}
FROM (
    SELECT ${FINAL_OUTCOME} AS final_outcome
    FROM (
        SELECT ${columns
          .map((field) => `any(run.${field}) AS ${field}`)
          .join(", ")}
        FROM ${CI_DATABASE}.runs AS run
        ${multiRowWhere}
        GROUP BY ${RUN_START}
        HAVING count() = 1
        UNION ALL
        SELECT ${columns.map((field) => `run.${field} AS ${field}`).join(", ")}
        FROM ${CI_DATABASE}.runs AS run FINAL
        PREWHERE (${RUN_START}) IN (${sharedStartsSubquery(multiRowWhere)})
        ${multiRowWhere}
    ) AS run
    GROUP BY ${RUN_GROUP_FIELDS.map((field) => `run.${field}`).join(", ")}
)
SETTINGS optimize_move_to_prewhere_if_final = 0
`,
  };
}
