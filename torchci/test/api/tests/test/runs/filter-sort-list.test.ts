import { GET as getCommitRuns } from "app/api/tests/commit/[sha]/route";
import { GET as getTestRuns } from "app/api/tests/test/[test_id]/runs/route";
import type { ListPageData } from "lib/api/schema";
import { decodeCommitRunsCursor } from "lib/api/tests/commit/cursor";
import { listCommitRuns } from "lib/api/tests/commit/list";
import { decodeRunsCursor } from "lib/api/tests/test/runs/cursor";
import { listRuns } from "lib/api/tests/test/runs/list";
import { RunsListQuery } from "lib/api/tests/test/runs/parameters";
import {
  RunFields,
  RunListPage,
  RunRecord,
} from "lib/api/tests/test/runs/types";
import * as clickhouse from "lib/clickhouse";
import { callRoute } from "../../../routes";
import {
  attemptRow,
  bundleOutcomes,
  groupedRunRecord,
  runRecord,
  runStats,
  SORT_CASES,
  TEST_ID,
} from "./fixtures";

type Scalar = string | bigint | boolean | null | Scalar[];
type Fixture = {
  run: RunFields;
  insert_order?: number;
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
  if (name === "outcome" || name === "id") return row.run[name];
  if (!(name in row.run)) throw new Error(`Unexpected fixture column ${field}`);
  return BigInt(row.run[name]);
}

function compareScalar(left: Scalar, right: Scalar): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  if (Array.isArray(left) && Array.isArray(right)) {
    for (let index = 0; index < left.length; index++) {
      const order = compareScalar(left[index], right[index]);
      if (order !== 0) return order;
    }
    return 0;
  }
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
  params: Record<string, unknown>,
  group?: Fixture[]
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
      const values = [expression()];
      while (tokens[position] === ",") {
        position++;
        values.push(expression());
      }
      take(")");
      return values.length === 1 ? values[0] : values;
    }
    if (token === "NULL") return null;
    if (/^\d+$/.test(token)) return BigInt(token);
    if (token.startsWith("{")) {
      const [, name, type] = token.match(/^\{(\w+):\s*(\w+(?:\(\w+\))?)\}$/)!;
      if (type.startsWith("Array(")) {
        return (params[name] as (string | number)[]).map((value) =>
          type === "Array(String)" ? String(value) : BigInt(value)
        );
      }
      return type === "String"
        ? String(params[name])
        : BigInt(params[name] as string);
    }
    if (tokens[position] !== "(") return valueFor(row, token);
    position++;
    if (token === "countIf" || token === "argMax") {
      if (!group) throw new Error(`Aggregate outside a group: ${source}`);
      const start = position;
      let depth = 1;
      while (depth) {
        if (tokens[position] === "(") depth++;
        if (tokens[position] === ")") depth--;
        position++;
      }
      const args = splitColumns(tokens.slice(start, position - 1).join(" "));
      if (token === "countIf") {
        return BigInt(
          group.filter((attempt) => evaluate(args[0], attempt, params)).length
        );
      }
      const last = group.reduce((left, right) =>
        compareScalar(
          evaluate(args[1], left, params),
          evaluate(args[1], right, params)
        ) < 0
          ? right
          : left
      );
      return evaluate(args[0], last, params);
    }
    const args = [expression()];
    while (tokens[position] === ",") {
      position++;
      args.push(expression());
    }
    take(")");
    switch (token) {
      case "isNull":
        return args[0] === null;
      case "isNotNull":
        return args[0] !== null;
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
    if (!["=", "<", ">", "IN"].includes(operator)) return left;
    position++;
    const right = primary();
    if (operator === "IN") {
      if (!Array.isArray(right)) throw new Error(`Expected array: ${source}`);
      return right.some((value) => compareScalar(left, value) === 0);
    }
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
    const match = column.match(/^(.+) (ASC|DESC)(?: NULLS (LAST|FIRST))?$/);
    if (!match) throw new Error(`Unexpected ordering ${column}`);
    return {
      expression: match[1],
      descending: match[2] === "DESC",
      nullsFirst: match[3] === "FIRST",
    };
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
  const retained = /FROM ci\.runs AS run FINAL/.test(sql)
    ? finalFixtures(rows)
    : rows;
  // The grouped query's HAVING sits at four spaces; a by_job scope's
  // shared-start classification nests its own HAVING deeper inside the
  // union source, so anchor on the indentation.
  const having = sql.match(/\n {4}HAVING ([\s\S]+?)\n\) AS run/)?.[1];
  return groupFixtures(retained)
    .filter((row) => !params.test_id || row.run.tests_id === params.test_id)
    .filter(
      (row) =>
        !having ||
        evaluate(
          having,
          row,
          params,
          retained.filter((attempt) => sameGroup(attempt.run, row.run))
        )
    )
    .filter((row) => evaluate(predicate, row, params))
    .sort((left, right) => {
      for (const key of keys) {
        const a = evaluate(key.expression, left, params);
        const b = evaluate(key.expression, right, params);
        const order = compareScalar(a, b);
        if (order !== 0)
          return (
            order *
            (a === null || b === null
              ? key.nullsFirst
                ? -1
                : 1
              : key.descending
              ? -1
              : 1)
          );
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
    owner: "cuda",
    device_count: BigInt(255),
    workflow_path: ".github/workflows/z.yml",
  },
  {
    file: "λ雪😀",
    owner: "cuda",
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

// ReplacingMergeTree keeps the last inserted row for the full ORDER BY key.
// An explicit insert order lets page discovery receive shuffled stored rows.
function finalFixtures(rows: Fixture[]) {
  const retained = new Map<string, Fixture>();
  for (const row of [...rows].sort(
    (left, right) => (left.insert_order ?? 0) - (right.insert_order ?? 0)
  )) {
    const run = row.run;
    retained.set(
      JSON.stringify([
        run.tests_id,
        run.environments_id,
        run.env_vars_id,
        run.started_at,
        run.github_workflow_job_id,
        run.rerun_number,
      ]),
      row
    );
  }
  return [...retained.values()];
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

function matchingAttempts(params: Record<string, unknown>, rows = fixtures) {
  const tests = Object.keys(params).filter((key) =>
    /^group_\d+_tests_id$/.test(key)
  );
  return finalFixtures(rows)
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
              ? [runStats(bundleOutcomes(fixtures.map(({ run }) => run)))]
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
                  ? left[field as keyof Omit<Fixture, "run" | "insert_order">]
                  : valueFor(left, `run.${field}`);
              const b =
                field in right
                  ? right[field as keyof Omit<Fixture, "run" | "insert_order">]
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
        const expectedRuns = expected.map(({ run }) =>
          groupedRunRecord(
            fixtures
              .filter((row) => sameGroup(row.run, run))
              .map(({ run }) => run)
          )
        );
        const readPage = async (token: string | null, limit: number) => {
          const response = await callRoute(
            commit ? getCommitRuns : getTestRuns,
            commit
              ? "/api/tests/commit/{sha}"
              : "/api/tests/test/{test_id}/runs",
            {
              ...(commit
                ? {
                    sha: "0123456789abcdef0123456789abcdef01234567",
                    repo: "pytorch/pytorch",
                  }
                : { test_id: TEST_ID }),
              sort: sort.join(","),
              limit: String(limit),
              ...(token === null ? {} : { cursor: token }),
            }
          );
          expect(response.status).toBe(200);
          return response.body;
        };
        const actual: RunRecord[] = [];
        let token: string | null = null;
        let pages = 0;
        let lastPage: Awaited<ReturnType<typeof readPage>>;
        do {
          const limit = pages++ % 2 === 0 ? 1 : 2;
          const page = await readPage(token, limit);
          expect(pages).toBeLessThanOrEqual(fixtures.length);
          if (commit) {
            expect(page).toHaveProperty(
              "stats",
              runStats(bundleOutcomes(fixtures.map(({ run }) => run)))
            );
          } else {
            expect(page).not.toHaveProperty("stats");
          }
          expect(page).not.toHaveProperty("total_runs");
          expect(page.pagination.previous === null).toBe(actual.length === 0);
          actual.push(...page.runs);
          token = page.pagination.next?.cursor ?? null;
          if (token)
            expect(
              commit ? decodeCommitRunsCursor(token) : decodeRunsCursor(token)
            ).toMatchObject({ direction: "next" });
          lastPage = page;
        } while (token !== null);
        expect(actual).toEqual(expectedRuns);

        let end = expectedRuns.length - lastPage!.runs.length;
        token = lastPage!.pagination.previous?.cursor ?? null;
        while (token !== null) {
          const limit = pages++ % 2 === 0 ? 1 : 3;
          const page = await readPage(token, limit);
          const start = Math.max(0, end - limit);
          expect(page.runs).toEqual(expectedRuns.slice(start, end));
          expect(page.pagination.previous === null).toBe(start === 0);
          expect(page.pagination.next).not.toBeNull();
          // Next from a previous page starts at its actual last entry, even
          // when the backward request used a different page size.
          const forward = await readPage(page.pagination.next.cursor, 2);
          expect(forward.runs).toEqual(expectedRuns.slice(end, end + 2));
          token = page.pagination.previous?.cursor ?? null;
          if (token) {
            expect(
              commit ? decodeCommitRunsCursor(token) : decodeRunsCursor(token)
            ).toMatchObject({ direction: "previous" });
          }
          end = start;
          expect(pages).toBeLessThanOrEqual(fixtures.length * 2);
        }
        expect(end).toBe(0);
      }
    );
  }
);

describe.each([false, true])("last-attempt filtering (commit=%s)", (commit) => {
  afterEach(() => jest.restoreAllMocks());

  const first = (job: number, overrides: Partial<RunFields> = {}): Fixture => ({
    file: null,
    owner: null,
    device_count: null,
    workflow_path: null,
    run: runRecord({
      github_workflow_job_id: String(job),
      id: `00000000-0000-4000-8000-${String(job * 10).padStart(12, "0")}`,
      ...overrides,
    }),
  });
  const retry = (job: number, overrides: Partial<RunFields> = {}) =>
    first(job, {
      id: `00000000-0000-4000-8000-${String(job * 10 + 1).padStart(12, "0")}`,
      outcome: "passed",
      rerun_number: 1,
      started_at: "2026-10-19T16:29:00.000Z",
      ended_at: "2026-10-19T16:29:01.000Z",
      ...overrides,
    });
  const stored = [
    first(1),
    first(2),
    retry(2),
    first(3, { outcome: "passed" }),
    retry(3, { outcome: "failed" }),
    first(4, { rerun_number: 7 }),
    retry(4, {
      rerun_number: 0,
      report_uuid: "00000000-0000-4000-8000-000000000002",
    }),
    // Equal start: end time decides, even with a smaller execution UUID.
    first(5, { rerun_number: 9 }),
    first(5, {
      id: "00000000-0000-4000-8000-000000000000",
      outcome: "passed",
      ended_at: "2026-10-19T16:28:13.577Z",
    }),
    // Equal start and end: UUID decides, independently of reporter counters.
    first(6, { rerun_number: 9 }),
    first(6, {
      id: "00000000-0000-4000-8000-000000000061",
      outcome: "passed",
    }),
    first(7, { outcome: "passed" }),
    // A replacement corrected an old failure and its end time. FINAL must
    // precede both matching an attempt and choosing the latest attempt.
    {
      ...first(8, { ended_at: "2026-10-19T16:29:00.000Z" }),
      insert_order: 1,
    },
    { ...first(8, { outcome: "passed" }), insert_order: 2 },
  ];
  const retained = finalFixtures(stored);
  const stats = runStats(bundleOutcomes(retained.map(({ run }) => run)));
  const cases: {
    name: string;
    filters: Pick<
      RunsListQuery,
      "outcome" | "last_attempt_outcome" | "rerun_number"
    >;
    jobs: number[];
  }[] = [
    {
      name: "last passed",
      filters: { last_attempt_outcome: ["passed"] },
      jobs: [2, 4, 5, 6, 7, 8],
    },
    {
      name: "contains failure and last passed",
      filters: { outcome: ["failed"], last_attempt_outcome: ["passed"] },
      jobs: [2, 4, 5, 6],
    },
    {
      name: "last failed",
      filters: { last_attempt_outcome: ["failed"] },
      jobs: [1, 3],
    },
    {
      name: "same initial attempt failed and last passed",
      filters: {
        outcome: ["failed"],
        rerun_number: [0],
        last_attempt_outcome: ["passed"],
      },
      jobs: [2],
    },
    {
      name: "earlier counter seven failed and last passed after a counter reset",
      filters: {
        outcome: ["failed"],
        rerun_number: [7],
        last_attempt_outcome: ["passed"],
      },
      jobs: [4],
    },
  ];

  test.each(cases)(
    "$name filters retained groups before pagination and preserves every attempt",
    async ({ filters, jobs }) => {
      const queryClickhouse = jest
        .spyOn(clickhouse, "queryClickhouse")
        .mockImplementation(async (sql, params, queryId) => {
          if (queryId === "api_run_catalog" || queryId === "api_run_workflow")
            return [];
          if (queryId === "api_run_attempts") {
            expect(params).not.toHaveProperty("outcome");
            expect(params).not.toHaveProperty("last_attempt_outcome");
            expect(params).not.toHaveProperty("rerun_number");
            return matchingAttempts(params, stored).reverse();
          }
          if (queryId === "api_commit_runs_stats") {
            expect(params).toEqual({
              repo: "pytorch/pytorch",
              sha: "0123456789abcdef0123456789abcdef01234567",
            });
            return [stats];
          }
          return answerFixtureQuery([...stored].reverse(), sql, params);
        });
      let token: string | null = null;
      let offset = 0;
      do {
        queryClickhouse.mockClear();
        const shared = { ...filters, sort: ["started_at"], limit: 2 };
        const page: ListPageData<RunListPage> = commit
          ? await listCommitRuns({
              query: {
                ...shared,
                sha: "0123456789abcdef0123456789abcdef01234567",
                repo: "pytorch/pytorch",
              },
              cursor: token ? decodeCommitRunsCursor(token) : null,
            })
          : await listRuns({
              query: { ...shared, test_id: TEST_ID },
              cursor: token ? decodeRunsCursor(token) : null,
            });
        const expectedJobs = jobs.slice(offset, offset + shared.limit);
        expect(page.runs).toEqual(
          expectedJobs.map((job) =>
            groupedRunRecord(
              retained
                .filter(({ run }) => run.github_workflow_job_id === String(job))
                .map(({ run }) => run)
            )
          )
        );
        // The lookahead determines the cursor but is never expanded.
        const attemptParams = queryClickhouse.mock.calls.find(
          (call) => call[2] === "api_run_attempts"
        )![1];
        expect(
          Object.entries(attemptParams)
            .filter(([key]) => key.endsWith("github_workflow_job_id"))
            .map(([, job]) => job)
        ).toEqual(expectedJobs.map(String));
        if (commit) expect(page).toHaveProperty("stats", stats);
        offset += page.runs.length;
        expect(offset).toBeLessThanOrEqual(jobs.length);
        expect(page.next_cursor !== null).toBe(offset < jobs.length);
        token = page.next_cursor;
      } while (token !== null);
      expect(offset).toBe(jobs.length);
    }
  );
});
