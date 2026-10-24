import type { TestListCursor } from "lib/api/tests/cursor";
import { CI_DATABASE } from "lib/api/tests/database";
import {
  FILTER_DEFINITIONS,
  FilterTarget,
  getSortTerms,
  IDENTITY_SORT_FIELDS,
  SEARCH_FIELDS,
  SORT_DEFINITIONS,
  TestListQuery,
} from "lib/api/tests/parameters";
import {
  buildEnvVarFilters,
  COMBINED_HEALTH_SQL,
  CONFIGURATION_COLUMNS_SQL,
  CONFIGURATION_JOINS_SQL,
  HEALTH_RESULT_COLUMNS_SQL,
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
  params: Record<string, unknown>
): string[] {
  return Object.entries(FILTER_DEFINITIONS).flatMap(([name, definition]) => {
    const values = query[name as keyof TestListQuery];
    if (definition.target !== target || values === undefined) return [];
    const parameter = `filter_${name}`;
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

export function sortKeys(query: TestListQuery) {
  const keys = getSortTerms(query.sort);
  // Results include configuration rows, so all three IDs break ties.
  for (const field of IDENTITY_SORT_FIELDS) {
    keys.push({ field, ...SORT_DEFINITIONS[field], direction: "asc" });
  }
  return keys;
}

// NULLS LAST in both directions, with equality on every preceding key.
// UInt64 cursor values stay decimal strings, including IDs above 2^53.
function afterCursor(
  keys: ReturnType<typeof sortKeys>,
  cursor: TestListCursor | null,
  params: Record<string, unknown>
): string {
  if (cursor === null) return "1";
  const prefix: string[] = [];
  const alternatives: string[] = [];
  keys.forEach((key, index) => {
    const column = `key_${index}`;
    const value = cursor.position.values[index];
    if (value === null) {
      prefix.push(`isNull(${column})`);
      return;
    }
    const parameter = `cursor_${index}`;
    params[parameter] = value;
    const bound = `{${parameter}: ${key.type}}`;
    const comparison = key.direction === "desc" ? "<" : ">";
    alternatives.push(
      `(${[
        ...prefix,
        `(${column} ${comparison} ${bound} OR isNull(${column}))`,
      ].join(" AND ")})`
    );
    prefix.push(`${column} = ${bound}`);
  });
  return alternatives.length === 0 ? "0" : alternatives.join(" OR ");
}

export function buildListQuery(
  query: TestListQuery,
  cursor: TestListCursor | null
): { sql: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = {
    repo: query.repo,
    ran_on: query.ran_on,
    window: query.window,
    entries_limit: query.limit + 1,
  };
  const testFilters = filters(query, "test", "test", params);
  const ownerFilters = filters(query, "owner", "owner", params);
  // Match combined configurations without dropping any selected source's counts.
  const healthFilters = filters(query, "health", "health", params);
  if (query.search !== undefined) {
    params.search = query.search;
    testFilters.push(
      `(${SEARCH_FIELDS.map(
        (field) => `test.${FILTER_DEFINITIONS[field].column} = {search: String}`
      ).join(" OR ")})`
    );
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
  const groupBy = "tests_id, environments_id, env_vars_id";
  const keys = sortKeys(query);
  const predicate = afterCursor(keys, cursor, params);

  // Build the hash join from the smaller catalog on the right. The health
  // aggregate has many configuration rows per test, and the legacy analyzer
  // does not swap INNER JOIN inputs automatically.
  const sql = `
WITH catalog AS (
    SELECT
${TEST_CATALOG_COLUMNS_SQL}
    FROM ${CI_DATABASE}.tests AS test FINAL
    LEFT JOIN (
        SELECT repo, file, owners FROM ${CI_DATABASE}.owners FINAL
        WHERE repo = {repo: String}
    ) AS owner ON owner.repo = test.repo AND owner.file = test.file
    WHERE test.repo = {repo: String}
        ${[...testFilters, ...ownerFilters]
          .map((filter) => `AND ${filter}`)
          .join("\n        ")}
), combined_health AS (
    SELECT
        ${groupBy},${COMBINED_HEALTH_SQL}
    FROM ${CI_DATABASE}.health
    WHERE window = {window: String} AND ran_on IN {ran_on: Array(String)}
        AND tests_id IN (SELECT tests_id FROM catalog)
        ${configurationFilters
          .map((filter) => `AND ${filter}`)
          .join("\n        ")}
    GROUP BY ${groupBy}
)
SELECT
    ranked.*,
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
        result.*,
        ${keys
          .map((key, index) => `${key.expression} AS key_${index}`)
          .join(",\n        ")}
    FROM (
        SELECT
${TEST_RESULT_COLUMNS_SQL}
            if(empty(owners), NULL, arraySort(owners)[1]) AS owner,
            health.has_health AS has_health,
            health.refreshed_at AS refreshed_at,
            health.workflow_paths_combined AS workflow_paths_combined,
            ${HEALTH_RESULT_COLUMNS_SQL},
${CONFIGURATION_COLUMNS_SQL}
        FROM combined_health AS health
        INNER JOIN catalog ON health.tests_id = catalog.tests_id
${CONFIGURATION_JOINS_SQL}
        ${healthFilters.length ? `WHERE ${healthFilters.join(" AND ")}` : ""}
    ) AS result
) AS ranked
WHERE ${predicate}
ORDER BY ${keys
    .map(
      (key, index) => `key_${index} ${key.direction.toUpperCase()} NULLS LAST`
    )
    .join(", ")}
LIMIT {entries_limit: UInt64}
SETTINGS optimize_aggregation_in_order = 1
`;
  return { sql, params };
}
