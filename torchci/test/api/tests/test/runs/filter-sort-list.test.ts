import { decodeCommitRunsCursor } from "lib/api/tests/commit/cursor";
import { listCommitRuns } from "lib/api/tests/commit/list";
import { decodeRunsCursor } from "lib/api/tests/test/runs/cursor";
import { listRuns } from "lib/api/tests/test/runs/list";
import {
  RunFields,
  RunListPage,
  RunRecord,
} from "lib/api/tests/test/runs/types";
import * as clickhouse from "lib/clickhouse";
import {
  attemptRow,
  groupedRunRecord,
  runRecord,
  runStats,
  SORT_CASES,
  TEST_ID,
} from "./fixtures";

type Scalar = string | bigint | boolean | null;
type Fixture = {
  run: RunFields;
  file: string | null;
  owner: string | null;
  device_count: bigint | null;
  workflow_path: string | null;
};

function valueFor(row: Fixture, field: string): Scalar {
  if (field === "run_test.has_catalog")
    return row.file === null ? BigInt(0) : BigInt(1);
  if (field === "run_environment.has_catalog") {
    return row.device_count === null ? BigInt(0) : BigInt(1);
  }
  if (field === "run_test.file") return row.file ?? "";
  if (field === "run_test.owner") return row.owner;
  if (field === "run_environment.device_count")
    return row.device_count ?? BigInt(0);
  if (field === "run_workflow.workflow_path") return row.workflow_path;
  const name = field.replace(/^run\./, "") as keyof RunFields;
  if (name === "started_at" || name === "ended_at") {
    return BigInt(Date.parse(row.run[name]));
  }
  if (name === "outcome") return row.run.outcome;
  if (!(name in row.run)) throw new Error(`Unexpected fixture column ${field}`);
  return BigInt(row.run[name]);
}

function compareScalar(left: Scalar, right: Scalar) {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  if (typeof left === "string" && typeof right === "string") {
    return Buffer.compare(
      Uint8Array.from(Buffer.from(left)),
      Uint8Array.from(Buffer.from(right))
    );
  }
  return left < right ? -1 : 1;
}

// Evaluate the emitted SQL expressions, rather than using the production sort
// keys or cursor builder. Missing equality prefixes, wrong direction, and NULL
// handling therefore change which rows are returned and fail the page oracle.
function evaluate(
  source: string,
  row: Fixture,
  params: Record<string, unknown>
): Scalar {
  const tokens =
    source.match(/\{[^}]+\}|[A-Za-z_]\w*(?:\.\w+)*|\d+|[(),<>=]/g) ?? [];
  let position = 0;
  function take(expected: string) {
    if (tokens[position++] !== expected)
      throw new Error(`Expected ${expected}: ${source}`);
  }
  function primary(): Scalar {
    const token = tokens[position++];
    if (token === "(") {
      const value = expression();
      take(")");
      return value;
    }
    if (token === "NULL") return null;
    if (/^\d+$/.test(token)) return BigInt(token);
    if (token.startsWith("{")) {
      const [, name, type] = token.match(/^\{(\w+):\s*(\w+)\}$/)!;
      return type === "String"
        ? String(params[name])
        : BigInt(params[name] as string);
    }
    if (tokens[position] !== "(") return valueFor(row, token);
    position++;
    const args = [expression()];
    while (tokens[position] === ",") {
      position++;
      args.push(expression());
    }
    take(")");
    switch (token) {
      case "isNull":
        return args[0] === null;
      case "if":
        return args[0] ? args[1] : args[2];
      case "toString":
        return args[0] === null ? null : String(args[0]);
      case "toUnixTimestamp64Milli":
      case "fromUnixTimestamp64Milli":
        return args[0];
      default:
        throw new Error(`Unexpected SQL function ${token}`);
    }
  }
  function comparison(): Scalar {
    const left = primary();
    const operator = tokens[position];
    if (!["=", "<", ">"].includes(operator)) return left;
    position++;
    const right = primary();
    if (left === null || right === null) return false;
    const order = compareScalar(left, right);
    return operator === "="
      ? order === 0
      : operator === "<"
      ? order < 0
      : order > 0;
  }
  function conjunction(): Scalar {
    let value = comparison();
    while (tokens[position] === "AND") {
      position++;
      const right = comparison();
      value = Boolean(value && right);
    }
    return value;
  }
  function expression(): Scalar {
    let value = conjunction();
    while (tokens[position] === "OR") {
      position++;
      const right = conjunction();
      value = Boolean(value || right);
    }
    return value;
  }
  const result = expression();
  if (position !== tokens.length) throw new Error(`Unconsumed SQL: ${source}`);
  return result;
}

function splitColumns(sql: string) {
  let depth = 0;
  let start = 0;
  const columns = [];
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    if (sql[i] === ")") depth--;
    if (sql[i] === "," && depth === 0) {
      columns.push(sql.slice(start, i).trim());
      start = i + 1;
    }
  }
  columns.push(sql.slice(start).trim());
  return columns;
}

// The page is selected by the query block with the page limit: the outer
// query, or the page-key subquery whose runs FINAL reads afterwards.
function answerFixtureQuery(
  rows: Fixture[],
  sql: string,
  params: Record<string, unknown>
) {
  const limit = sql.lastIndexOf("LIMIT {entries_limit: UInt64}");
  const orderAt = sql.lastIndexOf("ORDER BY ", limit);
  const order = sql
    .slice(orderAt + "ORDER BY ".length, limit)
    .replace(/\s*LIMIT 1 BY [\s\S]*$/, "")
    .trim();
  if (!order) throw new Error("Missing page ordering");
  const keys = splitColumns(order).map((column) => {
    const match = column.match(/^(.+) (ASC|DESC)(?: NULLS LAST)?$/);
    if (!match) throw new Error(`Unexpected ordering ${column}`);
    return { expression: match[1], descending: match[2] === "DESC" };
  });
  const beforeOrder = sql.slice(0, orderAt);
  const predicateAt = [...beforeOrder.matchAll(/\n\s+AND \(/g)].pop()?.index;
  if (predicateAt === undefined) throw new Error("Missing cursor predicate");
  const predicate = beforeOrder.slice(predicateAt).trim().slice(5, -1);
  // page_key.N names the Nth element of the page_entry tuple.
  const entry = sql.match(/SELECT \(\n([\s\S]+?)\n\s*\) AS page_entry/)?.[1];
  const elements = entry ? splitColumns(entry) : [];
  const projections = [...sql.matchAll(/^    (.+) AS (sort_\d+),?$/gm)].map(
    ([match, expression, name]) => [
      match,
      expression.replace(
        /page_key\.(\d+)/g,
        (_, position) => elements[Number(position) - 1]
      ),
      name,
    ]
  );
  expect(projections).toHaveLength(keys.length);
  return groupFixtures(rows)
    .filter((row) => !params.test_id || row.run.tests_id === params.test_id)
    .filter((row) => evaluate(predicate, row, params))
    .sort((left, right) => {
      for (const key of keys) {
        const a = evaluate(key.expression, left, params);
        const b = evaluate(key.expression, right, params);
        const order = compareScalar(a, b);
        if (order !== 0)
          return order * (a !== null && b !== null && key.descending ? -1 : 1);
      }
      return 0;
    })
    .slice(0, params.entries_limit as number)
    .map((row) => ({
      ...row.run,
      tests_id_string: row.run.tests_id,
      environments_id_string: row.run.environments_id,
      env_vars_id_string: row.run.env_vars_id,
      github_workflow_job_id_string: row.run.github_workflow_job_id,
      ...Object.fromEntries(
        projections.map(([, expression, name]) => [
          name,
          evaluate(expression, row, params),
        ])
      ),
    }));
}

const fixtures: Fixture[] = [
  { file: null, owner: null, device_count: null, workflow_path: null },
  {
    file: "",
    owner: "",
    device_count: BigInt(0),
    workflow_path: ".github/workflows/a.yml",
  },
  { file: "a,b", owner: "a,b", device_count: BigInt(255), workflow_path: null },
  {
    file: "' OR 1=1 --",
    owner: "core_tests",
    device_count: BigInt(0),
    workflow_path: ".github/workflows/a.yml",
  },
  {
    file: "λ雪😀",
    owner: null,
    device_count: null,
    workflow_path: ".github/workflows/z.yml",
  },
  {
    file: "λ雪😀",
    owner: "module: cuda",
    device_count: BigInt(255),
    workflow_path: ".github/workflows/z.yml",
  },
  {
    file: "λ雪😀",
    owner: "module: cuda",
    device_count: BigInt(255),
    workflow_path: ".github/workflows/z.yml",
  },
  { file: null, owner: null, device_count: null, workflow_path: null },
].map((metadata, index) => ({
  ...metadata,
  run: runRecord({
    tests_id: index === 7 ? "0" : TEST_ID,
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    github_workflow_job_id: String(index === 6 ? 5 : index),
    started_at:
      index === 6 ? "2026-10-19T16:29:00.000Z" : "2026-10-19T16:28:13.575Z",
    ended_at:
      index === 6 ? "2026-10-19T16:29:01.000Z" : "2026-10-19T16:28:13.576Z",
    rerun_number: index === 6 ? 1 : 0,
    outcome: index % 3 === 0 ? "error" : "failed",
  }),
}));

function sameGroup(left: RunFields, right: RunFields) {
  return (
    left.tests_id === right.tests_id &&
    left.environments_id === right.environments_id &&
    left.env_vars_id === right.env_vars_id &&
    left.github_workflow_job_id === right.github_workflow_job_id
  );
}

function groupFixtures(rows: Fixture[]): Fixture[] {
  const groups: Fixture[][] = [];
  for (const row of rows) {
    const group = groups.find((group) => sameGroup(group[0].run, row.run));
    if (group) group.push(row);
    else groups.push([row]);
  }
  return groups.map((rows) => {
    const chronological = rows.slice().sort((left, right) => {
      for (const field of ["started_at", "ended_at", "id"] as const) {
        if (left.run[field] !== right.run[field])
          return left.run[field] < right.run[field] ? -1 : 1;
      }
      return 0;
    });
    const last = chronological[chronological.length - 1];
    return {
      ...last,
      run: {
        ...last.run,
        started_at: chronological[0].run.started_at,
        ended_at: rows
          .map(({ run }) => run.ended_at)
          .sort()
          .slice(-1)[0],
      },
    };
  });
}

function matchingAttempts(params: Record<string, unknown>) {
  const tests = Object.keys(params).filter((key) =>
    /^group_\d+_tests_id$/.test(key)
  );
  return fixtures
    .filter(({ run }) =>
      tests.some((parameter) => {
        const prefix = parameter.slice(0, -"tests_id".length);
        return [
          "tests_id",
          "environments_id",
          "env_vars_id",
          "github_workflow_job_id",
        ].every(
          (field) =>
            run[field as keyof RunFields] === params[`${prefix}${field}`]
        );
      })
    )
    .map(({ run }) => attemptRow(run));
}

const sorts = [
  ...SORT_CASES.map(({ sort }) => sort),
  ["file"],
  ["-file"],
  ["owner"],
  ["-owner"],
  ["device_count"],
  ["-device_count"],
  ["workflow_path"],
  ["-workflow_path"],
  ["outcome"],
  ["-outcome"],
  ["rerun_number"],
  ["-rerun_number"],
  ["owner", "-device_count", "outcome", "-rerun_number"],
  ["-workflow_path", "file", "-ended_at"],
];

describe.each([false, true])(
  "metadata-sort pagination (commit=%s)",
  (commit) => {
    afterEach(() => jest.restoreAllMocks());

    test.each(sorts.map((sort) => ({ sort })))(
      "returns every tied, empty and missing value once for $sort",
      async ({ sort }) => {
        jest
          .spyOn(clickhouse, "queryClickhouse")
          .mockImplementation(async (sql, params, queryId) =>
            queryId === "api_run_catalog" || queryId === "api_run_workflow"
              ? []
              : queryId === "api_run_attempts"
              ? matchingAttempts(params)
              : queryId === "api_commit_runs_stats"
              ? [runStats(fixtures.map(({ run }) => run.outcome))]
              : answerFixtureQuery([...fixtures].reverse(), sql, params)
          );
        const identity = [
          ...(commit ? ["tests_id"] : []),
          "environments_id",
          "env_vars_id",
          "github_workflow_job_id",
        ];
        const fields = [
          ...sort,
          ...identity.filter(
            (field) => !sort.some((value) => value.replace(/^-/, "") === field)
          ),
        ];
        const expected = groupFixtures(fixtures)
          .filter((row) => commit || row.run.tests_id === TEST_ID)
          .sort((left, right) => {
            for (const value of fields) {
              const field = value.replace(/^-/, "");
              const a =
                field in left
                  ? left[field as keyof Omit<Fixture, "run">]
                  : valueFor(left, `run.${field}`);
              const b =
                field in right
                  ? right[field as keyof Omit<Fixture, "run">]
                  : valueFor(right, `run.${field}`);
              const order = compareScalar(a, b);
              if (order !== 0)
                return (
                  order *
                  (a !== null && b !== null && value.startsWith("-") ? -1 : 1)
                );
            }
            return 0;
          });
        const actual: RunRecord[] = [];
        let token: string | null = null;
        let pages = 0;
        do {
          const limit = pages++ % 2 === 0 ? 1 : 2;
          const page: RunListPage = commit
            ? await listCommitRuns({
                query: {
                  sha: "0123456789abcdef0123456789abcdef01234567",
                  repo: "pytorch/pytorch",
                  sort,
                  limit,
                },
                cursor: token ? decodeCommitRunsCursor(token) : null,
              })
            : await listRuns({
                query: { test_id: TEST_ID, sort, limit },
                cursor: token ? decodeRunsCursor(token) : null,
              });
          expect(pages).toBeLessThanOrEqual(fixtures.length);
          if (commit) {
            expect(page).toHaveProperty(
              "stats",
              runStats(fixtures.map(({ run }) => run.outcome))
            );
          } else {
            expect(page).not.toHaveProperty("stats");
          }
          expect(page).not.toHaveProperty("total_runs");
          actual.push(...page.runs);
          token = page.next_cursor;
          if (token)
            expect(
              commit ? decodeCommitRunsCursor(token) : decodeRunsCursor(token)
            ).not.toBeNull();
        } while (token !== null);
        expect(actual).toEqual(
          expected.map(({ run }) =>
            groupedRunRecord(
              fixtures
                .filter((row) => sameGroup(row.run, run))
                .map(({ run }) => run)
            )
          )
        );
      }
    );
  }
);
