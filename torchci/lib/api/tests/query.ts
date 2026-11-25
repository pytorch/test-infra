import { SeekKey, seekOrderBy, seekPredicate } from "lib/api/seek";
import type { TestListCursor } from "lib/api/tests/cursor";
import { CI_DATABASE } from "lib/api/tests/database";
import {
  FILTER_DEFINITIONS,
  FilterField,
  FilterTarget,
  getSortTerms,
  HEALTH_SORT_FIELDS,
  IDENTITY_SORT_FIELDS,
  SORT_DEFINITIONS,
  SortField,
  TestListQuery,
} from "lib/api/tests/parameters";
import {
  buildEnvVarFilters,
  COMBINED_HEALTH_SQL,
  CONFIGURATION_COLUMNS_SQL,
  CONFIGURATION_JOINS_SQL,
  HEALTH_RESULT_COLUMNS_SQL,
  HEALTH_SUMMARY_COLUMNS,
  searchPredicateSql,
  SINGLE_SOURCE_HEALTH_SQL,
  TEST_CATALOG_COLUMNS_SQL,
  TEST_RESULT_COLUMNS_SQL,
} from "lib/api/tests/shared-sql";

// Public parameter names, allowed columns and types all come from the
// parameter registry. Only values from that registry can become SQL syntax;
// everything supplied by the caller is bound as a query parameter.
function filters(
  query: TestListQuery,
  target: FilterTarget,
  alias: string,
  params: Record<string, unknown>,
  // What the bindings' names start with. A statement that holds the filters
  // of several requests binds each request's under names of its own
  // (buildHealthFilters).
  prefix = "filter_",
  // Only the filters that search an array, or only those that do not.
  arrays?: boolean
): string[] {
  return Object.entries(FILTER_DEFINITIONS).flatMap(([name, definition]) => {
    const values = query[name as keyof TestListQuery];
    if (definition.target !== target || values === undefined) return [];
    if (arrays !== undefined && (definition.match === "array") !== arrays) {
      return [];
    }
    const parameter = `${prefix}${name}`;
    params[parameter] = values;
    const set =
      definition.type === "UInt64"
        ? `CAST({${parameter}: Array(String)}, 'Array(UInt64)')`
        : `{${parameter}: Array(${definition.type})}`;
    const column = `${alias}.${definition.column}`;
    return [
      definition.match === "array"
        ? `hasAny(${column}, ${set})`
        : `${column} IN ${set}`,
    ];
  });
}

// The ids that make a configuration: a test in one environment with one env
// var set, the health table's sort key and the unit the list has an entry for.
const CONFIGURATION_IDS = ["tests_id", "environments_id", "env_vars_id"];

// What a list request selects, as SQL: every filter turned into a predicate
// with its value bound, and the health rows they keep, combined into one row
// per configuration. The list's page and the figures of
// GET /api/tests/summary (summary/query.ts) are both read from it, so a
// figure counts exactly the rows the list returns over all its pages.
export interface ListSelection {
  // The bindings of everything below: the repository, the window, the code
  // sources and each filter's values.
  params: Record<string, unknown>;
  // The predicates that keep a test, on the catalog row `test` and, for the
  // owner, on its owners row `owner` (ownersJoin).
  catalogFilters: string[];
  // Joins the owners of a test's file to `test`, at the given indent.
  ownersJoin: (_indent: string) => string;
  // The body of the combined_health CTE: the health rows of the window and
  // the code sources, of the tests the catalog filters keep and the
  // configurations the environment and env var filters keep, one row per
  // configuration with the columns of HEALTH_SUMMARY_COLUMNS.
  combinedHealthSql: string;
  // The predicates on the combined rows, read as `health`: the status and
  // the workflow paths, which exist only once the code sources are combined.
  healthFilters: string[];
}

export function buildSelection(query: TestListQuery): ListSelection {
  const params: Record<string, unknown> = {
    repo: query.repo,
    ran_on: query.ran_on,
    window: query.window,
  };
  const testFilters = filters(query, "test", "test", params);
  const ownerFilters = filters(query, "owner", "owner", params);
  // Match combined configurations without dropping any selected source's counts.
  const healthFilters = filters(query, "health", "health", params);
  if (query.search !== undefined) {
    params.search = query.search;
    testFilters.push(searchPredicateSql("test"));
  }
  const environmentFilters = filters(
    query,
    "environment",
    "environment",
    params
  );
  const envVarFilters = filters(query, "env_vars", "env_var_set", params);
  envVarFilters.push(...buildEnvVarFilters(query.env_vars, params));
  const configurationFilters = [
    ...(environmentFilters.length
      ? [
          `environments_id IN (
        SELECT id FROM ${CI_DATABASE}.environments AS environment FINAL
        WHERE ${environmentFilters.join(" AND ")}
    )`,
        ]
      : []),
    ...(envVarFilters.length
      ? [
          `env_vars_id IN (
        SELECT id FROM ${CI_DATABASE}.env_vars AS env_var_set FINAL
        WHERE ${envVarFilters.join(" AND ")}
    )`,
        ]
      : []),
  ];
  const groupBy = CONFIGURATION_IDS.join(", ");
  // One code source is one partition, which holds one row per configuration
  // (SINGLE_SOURCE_HEALTH_SQL): nothing to combine.
  const singleSource = query.ran_on.length === 1;
  const ownersJoin = (indent: string) => `
${indent}LEFT JOIN (
${indent}    SELECT repo, file, owners FROM ${CI_DATABASE}.owners FINAL
${indent}    WHERE repo = {repo: String}
${indent}) AS owner ON owner.repo = test.repo AND owner.file = test.file`;
  const catalogFilters = [...testFilters, ...ownerFilters];
  // The tests a configuration may belong to are matched by ID, read without
  // FINAL: the filters read the columns an ID hashes, so every stored row of
  // an ID answers them as its merged row does.
  const combinedHealthSql = `
    SELECT
        ${groupBy},${
    singleSource ? SINGLE_SOURCE_HEALTH_SQL : COMBINED_HEALTH_SQL
  }
    FROM ${CI_DATABASE}.health
    WHERE window = {window: String} AND ran_on IN {ran_on: Array(String)}
        AND tests_id IN (
            SELECT test.id
            FROM ${CI_DATABASE}.tests AS test${
    ownerFilters.length ? ownersJoin("            ") : ""
  }
            WHERE test.repo = {repo: String}${catalogFilters
              .map((filter) => `\n                AND ${filter}`)
              .join("")}
        )
        ${configurationFilters
          .map((filter) => `AND ${filter}`)
          .join("\n        ")}
    ${singleSource ? "" : `GROUP BY ${groupBy}`}
`;
  return {
    params,
    catalogFilters,
    ownersJoin,
    combinedHealthSql,
    healthFilters,
  };
}

// A request's filters on the combined health rows, read as `health`: the
// predicates buildSelection returns as healthFilters, in two kinds, with
// their values bound under names that start with the prefix. One kind
// compares a value the counts give (the status); the other searches an array
// (the workflow paths), which costs reading it. A statement that answers
// several requests over the same rows holds each request's filters under its
// own names (summary/query.ts).
export function buildHealthFilters(
  query: TestListQuery,
  params: Record<string, unknown>,
  prefix: string
): { values: string[]; arrays: string[] } {
  return {
    values: filters(query, "health", "health", params, prefix, false),
    arrays: filters(query, "health", "health", params, prefix, true),
  };
}

// The request without its filters on the combined health rows: what it
// selects before them, which requests that differ only in those filters
// share.
export function withoutHealthFilters(query: TestListQuery): TestListQuery {
  const definitions: Record<string, { target: FilterTarget }> =
    FILTER_DEFINITIONS;
  return Object.fromEntries(
    Object.entries(query).filter(
      ([name]) => definitions[name]?.target !== "health"
    )
  ) as TestListQuery;
}

export function sortKeys(query: TestListQuery) {
  const keys = getSortTerms(query.sort);
  // Results include configuration rows, so all three IDs break ties.
  for (const field of IDENTITY_SORT_FIELDS) {
    keys.push({ field, ...SORT_DEFINITIONS[field], direction: "asc" });
  }
  return keys;
}

// The page exposes each sort key as key_<index>. Every key may be
// NULL in principle (health, catalog and owner values; the IDs never are, and
// the clause is harmless for them), so all order NULLS LAST. UInt64 cursor
// values stay decimal strings, including IDs above 2^53.
function seekKeys(keys: ReturnType<typeof sortKeys>): SeekKey[] {
  return keys.map((key, index) => ({
    column: `key_${index}`,
    parameterType: key.type,
    direction: key.direction === "desc" ? "DESC" : "ASC",
    nullable: true,
  }));
}

// A test's alphabetically first owner label, NULL when it has none: what the
// owner sort orders by.
const OWNER_SQL = "if(empty(owners), NULL, arraySort(owners)[1])";

// The catalogs a page reads its catalog sort keys from, by the health column
// that holds their ID, each key's expression written over the catalog's row
// as the results name its columns. Every health row's test is in the
// catalog, which is what matched it; an environment or env var set may be
// missing, and then reads empty, as in the results.
const KEY_CATALOGS = {
  test: {
    column: "tests_id",
    join: "INNER JOIN",
    id: "tests_id",
    rows: `(SELECT *, ${OWNER_SQL} AS owner FROM catalog)`,
  },
  environment: {
    column: "environments_id",
    join: "LEFT JOIN",
    id: "id",
    rows: `${CI_DATABASE}.environments FINAL`,
  },
  env_vars: {
    column: "env_vars_id",
    join: "LEFT JOIN",
    id: "id",
    rows: `${CI_DATABASE}.env_vars FINAL`,
  },
} as const;

// The catalog a sort key is read from, or null for a health value or an ID,
// which the health row holds.
function keyCatalog(field: SortField): keyof typeof KEY_CATALOGS | null {
  if (
    (HEALTH_SORT_FIELDS as readonly string[]).includes(field) ||
    (IDENTITY_SORT_FIELDS as readonly string[]).includes(field)
  ) {
    return null;
  }
  const { target } = FILTER_DEFINITIONS[field as FilterField];
  if (target === "health") throw new Error(`Unsortable field: ${field}`);
  return target === "owner" ? "test" : target;
}

export function buildListQuery(
  query: TestListQuery,
  cursor: TestListCursor | null
): { sql: string; params: Record<string, unknown> } {
  const {
    params,
    catalogFilters,
    ownersJoin,
    combinedHealthSql,
    healthFilters,
  } = buildSelection(query);
  params.entries_limit = query.limit + 1;
  const keys = sortKeys(query);
  const seek = seekKeys(keys);
  const predicate = seekPredicate(seek, cursor, params);
  const previous = cursor?.direction === "previous";
  // The page's keys, each read where the page finds it: a health value or
  // ID off the health row, a catalog value from that catalog's row of the
  // health row's ID (KEY_CATALOGS).
  const pageKeys = keys.map((key, index) => {
    const catalog = keyCatalog(key.field);
    return catalog === null
      ? `${key.expression} AS key_${index}`
      : `page_${catalog}.value_${index} AS key_${index}`;
  });
  const keyJoins = (
    Object.keys(KEY_CATALOGS) as (keyof typeof KEY_CATALOGS)[]
  ).flatMap((name) => {
    const values = keys.flatMap((key, index) =>
      keyCatalog(key.field) === name
        ? [`${key.expression} AS value_${index}`]
        : []
    );
    if (values.length === 0) return [];
    const catalog = KEY_CATALOGS[name];
    return [
      `${catalog.join} (
            SELECT ${catalog.id} AS page_id, ${values.join(", ")}
            FROM ${catalog.rows}
        ) AS page_${name} ON page_${name}.page_id = health.${catalog.column}`,
    ];
  });

  // The page is chosen before the catalogs are joined: every filter applies
  // to the health rows or to the tests and configurations they are matched
  // against, and the sort keys are read beside them, so the page's rows are
  // found from the keys alone and the catalogs are joined to those rows
  // only, instead of to every configuration in the window before sorting
  // (query-validation.md, 2026-11-03). The tests a page may show are matched
  // by ID, read without FINAL (buildSelection).
  //
  // The page names every health column with an alias. With two catalog sort
  // keys its SELECT joins three tables, which the old analyzer rewrites into
  // nested subqueries, and a column selected without an alias, as health.*
  // selects them, comes out under its qualified name, health.tests_id, which
  // the outer query cannot find.
  const sql = `
WITH catalog AS (
    SELECT
${TEST_CATALOG_COLUMNS_SQL}
    FROM ${CI_DATABASE}.tests AS test FINAL${ownersJoin("    ")}
    WHERE test.repo = {repo: String}
        ${catalogFilters.map((filter) => `AND ${filter}`).join("\n        ")}
), combined_health AS (${combinedHealthSql}), page AS (
    SELECT
        ${[...CONFIGURATION_IDS, ...HEALTH_SUMMARY_COLUMNS]
          .map((column) => `health.${column} AS ${column}`)
          .join(",\n        ")},
        ${pageKeys.join(",\n        ")}
    FROM combined_health AS health${keyJoins
      .map((join) => `\n        ${join}`)
      .join("")}
    WHERE ${[...healthFilters, `(${predicate})`].join("\n        AND ")}
    ORDER BY ${seekOrderBy(seek, previous)}
    LIMIT {entries_limit: UInt64}
)
SELECT
    result.*,
    ${keys
      .map(
        (key, index) =>
          `${
            key.type === "UInt64" ? `toString(key_${index})` : `key_${index}`
          } AS sort_${index}`
      )
      .join(",\n    ")}
FROM (
    SELECT
${TEST_RESULT_COLUMNS_SQL}
        ${OWNER_SQL} AS owner,
        health.has_health AS has_health,
        health.refreshed_at AS refreshed_at,
        health.workflow_paths_combined AS workflow_paths_combined,
        ${HEALTH_RESULT_COLUMNS_SQL},
${CONFIGURATION_COLUMNS_SQL},
        ${keys
          .map((_, index) => `health.key_${index} AS key_${index}`)
          .join(",\n        ")}
    FROM page AS health
    INNER JOIN catalog ON health.tests_id = catalog.tests_id
${CONFIGURATION_JOINS_SQL}
) AS result
ORDER BY ${seekOrderBy(seek, previous)}
LIMIT {entries_limit: UInt64}
SETTINGS optimize_aggregation_in_order = 1
`;
  return { sql, params };
}
