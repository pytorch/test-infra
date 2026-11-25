import type { RawQuery } from "lib/api/parameters";
import { TEST_VIEWS } from "lib/api/tests/options/views";
import {
  DEFAULT_WINDOW,
  HealthWindow,
  parseTestListParams,
  TestListQuery,
} from "lib/api/tests/parameters";
import {
  buildHealthFilters,
  buildListQuery,
  buildSelection,
  withoutHealthFilters,
} from "lib/api/tests/query";
import {
  buildFigureStatements,
  buildTestRecordQuery,
  figureColumns,
  FigureKind,
  FiguresStatement,
} from "lib/api/tests/summary/query";
import { figureListQuery } from "lib/api/tests/summary/summary";

// The summary's statements: each reads the rows list requests select, as
// the list's own statement selects them, and nothing of the list's page;
// figures over the same rows share one; and each is asked for at a health
// refresh, which the server's query cache then keeps its answer for.

// The health refresh the statements are asked for at.
const GENERATION = "2026-10-25T12:00:00Z";

function listQuery(raw: RawQuery): TestListQuery {
  const parsed = parseTestListParams({ repo: "pytorch/pytorch", ...raw });
  if (!parsed.success) throw new Error(parsed.error.message);
  const { cursor: _cursor, ...query } = parsed.data;
  return query;
}

// The body of a statement's combined_health CTE, between its parentheses.
function combinedHealth(sql: string, next: string): string {
  const start = sql.indexOf("combined_health AS (");
  const end = sql.indexOf(next, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

// A statement after its combined_health CTE: what it selects from the rows.
function outer(statement: FiguresStatement): string {
  return statement.sql.slice(statement.sql.indexOf(")\nSELECT\n") + 2);
}

// Requests through every part of the selection: each view's figure, both
// code sources, and a filter on the test, its owner, its environment, its
// env var set and its combined health.
const REQUESTS: Record<string, TestListQuery> = {
  ...Object.fromEntries(
    TEST_VIEWS.map((view) => [
      `the ${view.id} view`,
      figureListQuery(view, {
        repo: "pytorch/pytorch",
        window: "7d",
        language: ["python"],
      }),
    ])
  ),
  "the list's defaults": listQuery({}),
  "both code sources": listQuery({
    ran_on: "main,pull_request",
    status: ["failing"],
  }),
  "every kind of filter": listQuery({
    ran_on: "main,pull_request",
    window: "3d",
    search: "conv",
    file: ["test/test_nn.py"],
    language: ["python", "cpp"],
    owner: ["nn"],
    accelerator: ["cuda"],
    device_count: ["1", "4"],
    environments_id: ["2081130751942693630"],
    test_config: ["default", "slow"],
    env_vars: JSON.stringify({ PYTORCH_TEST_WITH_INDUCTOR: ["1"] }),
    workflow_path: [".github/workflows/trunk.yml"],
    status: ["failing", "flaky"],
  }),
};

const KINDS: FigureKind[] = ["count", "slowest", "total_duration"];

// A figure of each kind over one request: positions 0, 1 and 2.
function ofEachKind(query: TestListQuery, generation = GENERATION) {
  return buildFigureStatements(
    KINDS.map((kind) => ({ kind, query })),
    generation
  );
}

// The summary's own figures, one per view, in the list's default window.
function ofTheViews(window: HealthWindow = DEFAULT_WINDOW) {
  return buildFigureStatements(
    TEST_VIEWS.map((view) => ({
      kind: view.figure.kind,
      query: figureListQuery(view, { repo: "pytorch/pytorch", window }),
    })),
    GENERATION
  );
}

const MEAN = "health.mean_passed_duration_milliseconds_combined";
const SLOWEST_ORDER = `(assumeNotNull(${MEAN}), bitNot(health.tests_id))`;

describe("the summary's statements", () => {
  describe.each(Object.entries(REQUESTS))("for %s", (_name, query) => {
    const list = buildListQuery(query, null);
    const statements = ofEachKind(query);
    const searchesArray = query.workflow_path !== undefined;
    // What the list binds for its filters on the combined rows.
    const listed = {
      ...(query.workflow_path === undefined
        ? {}
        : { workflow_path: query.workflow_path }),
      ...(query.status === undefined ? {} : { status: query.status }),
    };

    test("every figure is answered by exactly one statement", () => {
      expect(
        statements.flatMap((statement) => statement.figures).sort()
      ).toEqual([0, 1, 2]);
      // Figures over the same rows share one; a figure that searches an
      // array has one to itself.
      expect(statements.map((statement) => statement.figures)).toEqual(
        searchesArray ? [[0], [1], [2]] : [[0, 1, 2]]
      );
    });

    test("each statement reads the combined health rows the list reads, with the list's bindings", () => {
      // Everything the list binds but its page (the limit and, on a later
      // page, the cursor's position) and its filters on the combined rows,
      // which each figure binds under its own names.
      const {
        entries_limit: _limit,
        filter_status: _status,
        filter_workflow_path: _paths,
        ...selection
      } = list.params;
      expect(selection).not.toHaveProperty("generation");
      for (const statement of statements) {
        expect(combinedHealth(statement.sql, ")\nSELECT")).toBe(
          combinedHealth(list.sql, "), page AS (")
        );
        expect(statement.params).toEqual({
          ...selection,
          ...Object.fromEntries(
            statement.figures.flatMap((index) =>
              Object.entries(listed).map(([name, values]) => [
                `figure_${index}_filter_${name}`,
                values,
              ])
            )
          ),
          generation: GENERATION,
        });
      }
    });

    test("each figure keeps the combined rows by the list's own predicates", () => {
      // The list's page keeps the rows by these, then seeks within them.
      const predicates = buildSelection(query).healthFilters;
      expect(predicates).toEqual([
        ...(query.workflow_path === undefined
          ? []
          : [
              "hasAny(health.workflow_paths_combined, {filter_workflow_path: Array(String)})",
            ]),
        ...(query.status === undefined
          ? []
          : ["health.status IN {filter_status: Array(String)}"]),
      ]);
      for (const predicate of predicates) {
        expect(list.sql).toContain(predicate);
      }
      // A figure's are the same predicates, bound under the figure's names:
      // those that compare a value, and those that search an array.
      const params: Record<string, unknown> = {};
      const own = buildHealthFilters(query, params, "figure_7_filter_");
      const renamed = (predicate: string) =>
        predicate.replace("{filter_", "{figure_7_filter_");
      expect(own.arrays).toEqual(
        predicates.filter((p) => p.startsWith("hasAny(")).map(renamed)
      );
      expect(own.values).toEqual(
        predicates.filter((p) => !p.startsWith("hasAny(")).map(renamed)
      );
      expect(params).toEqual(
        Object.fromEntries(
          Object.entries(listed).map(([name, values]) => [
            `figure_7_filter_${name}`,
            values,
          ])
        )
      );
      // And every one of them is in the statement that answers the figure.
      for (const statement of statements) {
        for (const index of statement.figures) {
          const filters = buildHealthFilters(
            query,
            {},
            `figure_${index}_filter_`
          );
          for (const predicate of [...filters.values, ...filters.arrays]) {
            expect(outer(statement)).toContain(predicate);
          }
        }
      }
    });

    test("without its filters on the combined rows, the request selects what the statements read", () => {
      const bare = withoutHealthFilters(query);
      expect(bare).not.toHaveProperty("status");
      expect(bare).not.toHaveProperty("workflow_path");
      expect({ ...bare, ...listed }).toEqual(query);
      const selection = buildSelection(bare);
      expect(selection.healthFilters).toEqual([]);
      expect(selection.combinedHealthSql).toBe(
        buildSelection(query).combinedHealthSql
      );
    });

    // The server's query cache keys a kept answer by the statement with
    // its parameters bound: the refresh is one of them, so an answer kept
    // from one refresh is not the answer to the statement at the next.
    test("each statement is asked for at a refresh, which chooses no rows", () => {
      const later = ofEachKind(query, "2026-10-25T12:15:00Z");
      expect(later).toHaveLength(statements.length);
      statements.forEach((statement, index) => {
        // The same text at every refresh; the binding is what differs.
        expect(later[index].sql).toBe(statement.sql);
        expect(later[index].params).toEqual({
          ...statement.params,
          generation: "2026-10-25T12:15:00Z",
        });
        // Selected back as a constant, once, and nowhere a predicate.
        expect(statement.sql.match(/\{generation: String\}/g)).toHaveLength(1);
        expect(statement.sql).toContain(
          ",\n    {generation: String} AS generation\nFROM combined_health AS health"
        );
      });
    });

    test("no statement chooses a page, sorts, joins a catalog or reads the rows twice", () => {
      for (const statement of statements) {
        expect(outer(statement)).not.toMatch(
          /ORDER BY|LIMIT|JOIN|FINAL|entries_limit/
        );
        expect(statement.sql.match(/combined_health/g)).toHaveLength(2);
        expect(statement.sql).toMatch(
          /\nSETTINGS optimize_aggregation_in_order = 1\n$/
        );
      }
    });
  });

  test("in the default window the views' figures are read in three statements: the four over main's rows, and the two that are alone", () => {
    const statements = ofTheViews();
    expect(
      statements.map(({ figures }) =>
        figures.map((index) => TEST_VIEWS[index].id)
      )
    ).toEqual([
      ["unhealthy", "flaky_main", "slowest", "most_ci_time"],
      ["blocking_viable_strict"],
      ["flaky_pull_requests"],
    ]);
    // Over the same rows: each figure an aggregate over the rows its own
    // filters keep, and no row dropped before them.
    expect(outer(statements[0])).toBe(
      [
        "SELECT",
        "    countIf(health.status IN {figure_0_filter_status: Array(String)}) AS figure_0_count,",
        "    countIf(health.status IN {figure_2_filter_status: Array(String)}) AS figure_2_count,",
        `    max(${MEAN}) AS figure_4_duration_milliseconds,`,
        `    toString(argMaxIf(health.tests_id, ${SLOWEST_ORDER}, ${MEAN} IS NOT NULL)) AS figure_4_tests_id_string,`,
        "    sum(health.total_duration_milliseconds_combined) AS figure_5_duration_milliseconds,",
        "    {generation: String} AS generation",
        "FROM combined_health AS health",
        "SETTINGS optimize_aggregation_in_order = 1",
        "",
      ].join("\n")
    );
    expect(statements[0].params).toEqual({
      repo: "pytorch/pytorch",
      ran_on: ["main"],
      window: "3h",
      // The first view's figure counts the unhealthy rows, failing or flaky.
      figure_0_filter_status: ["failing", "flaky"],
      figure_2_filter_status: ["flaky"],
      generation: GENERATION,
    });
    // Alone, and searching the workflow paths: only the rows of its status
    // are kept, and the paths are looked at in those.
    expect(outer(statements[1])).toBe(
      [
        "SELECT",
        "    countIf(hasAny(health.workflow_paths_combined, {figure_1_filter_workflow_path: Array(String)})) AS figure_1_count,",
        "    {generation: String} AS generation",
        "FROM combined_health AS health",
        "WHERE health.status IN {figure_1_filter_status: Array(String)}",
        "SETTINGS optimize_aggregation_in_order = 1",
        "",
      ].join("\n")
    );
    expect(statements[1].params).toEqual({
      repo: "pytorch/pytorch",
      ran_on: ["main"],
      window: "12h",
      figure_1_filter_status: ["failing"],
      figure_1_filter_workflow_path: [
        ".github/workflows/pull.yml",
        ".github/workflows/trunk.yml",
      ],
      generation: GENERATION,
    });
    // Alone over the pull requests' rows: a count of the rows kept.
    expect(outer(statements[2])).toBe(
      [
        "SELECT",
        "    count() AS figure_3_count,",
        "    {generation: String} AS generation",
        "FROM combined_health AS health",
        "WHERE health.status IN {figure_3_filter_status: Array(String)}",
        "SETTINGS optimize_aggregation_in_order = 1",
        "",
      ].join("\n")
    );
    expect(statements[2].params).toEqual({
      repo: "pytorch/pytorch",
      ran_on: ["pull_request"],
      window: "3h",
      figure_3_filter_status: ["flaky"],
      generation: GENERATION,
    });
  });

  test("a view that sets its own window is read over it, whatever window the others are read over", () => {
    const ids = (statements: ReturnType<typeof ofTheViews>) =>
      statements.map(({ figures }) =>
        figures.map((index) => TEST_VIEWS[index].id)
      );
    // Two views set their own: the first, the list's defaults, the default
    // window, and Blocking viable/strict its 12 hours. In another window the
    // first is no longer over the rows the other views of main are read
    // over, so it is read alone, a fourth statement.
    const statements = ofTheViews("7d");
    expect(ids(statements)).toEqual([
      ["unhealthy"],
      ["blocking_viable_strict"],
      ["flaky_main", "slowest", "most_ci_time"],
      ["flaky_pull_requests"],
    ]);
    expect(statements.map(({ params }) => params.window)).toEqual([
      DEFAULT_WINDOW,
      "12h",
      "7d",
      "7d",
    ]);
    // Alone, a count of the rows its status keeps.
    expect(outer(statements[0])).toBe(
      [
        "SELECT",
        "    count() AS figure_0_count,",
        "    {generation: String} AS generation",
        "FROM combined_health AS health",
        "WHERE health.status IN {figure_0_filter_status: Array(String)}",
        "SETTINGS optimize_aggregation_in_order = 1",
        "",
      ].join("\n")
    );
    expect(statements[0].params).toEqual({
      repo: "pytorch/pytorch",
      ran_on: ["main"],
      window: DEFAULT_WINDOW,
      figure_0_filter_status: ["failing", "flaky"],
      generation: GENERATION,
    });
    // The others of main share theirs as before, without it.
    expect(outer(statements[2])).toBe(
      [
        "SELECT",
        "    countIf(health.status IN {figure_2_filter_status: Array(String)}) AS figure_2_count,",
        `    max(${MEAN}) AS figure_4_duration_milliseconds,`,
        `    toString(argMaxIf(health.tests_id, ${SLOWEST_ORDER}, ${MEAN} IS NOT NULL)) AS figure_4_tests_id_string,`,
        "    sum(health.total_duration_milliseconds_combined) AS figure_5_duration_milliseconds,",
        "    {generation: String} AS generation",
        "FROM combined_health AS health",
        "SETTINGS optimize_aggregation_in_order = 1",
        "",
      ].join("\n")
    );
    // In the list's default window the first view is over the same rows as
    // the others of main and shares their statement; that window is not
    // Blocking viable/strict's.
    expect(ids(ofTheViews())).toEqual([
      ["unhealthy", "flaky_main", "slowest", "most_ci_time"],
      ["blocking_viable_strict"],
      ["flaky_pull_requests"],
    ]);
    expect(ofTheViews().map(({ params }) => params.window)).toEqual([
      DEFAULT_WINDOW,
      "12h",
      DEFAULT_WINDOW,
    ]);
    // Asked for in its own window too, the view that searches an array is
    // alone, though it is then over the rows the others of main are read
    // over.
    const own = ofTheViews("12h");
    expect(own.map(({ params }) => params.window)).toEqual([
      DEFAULT_WINDOW,
      "12h",
      "12h",
      "12h",
    ]);
    expect(combinedHealth(own[1].sql, ")\nSELECT")).toBe(
      combinedHealth(own[2].sql, ")\nSELECT")
    );
  });

  test("with no filter on the combined rows, each figure is over all of them", () => {
    const [statement] = ofEachKind(REQUESTS["the list's defaults"]);
    expect(outer(statement)).toBe(
      [
        "SELECT",
        "    count() AS figure_0_count,",
        `    max(${MEAN}) AS figure_1_duration_milliseconds,`,
        `    toString(argMaxIf(health.tests_id, ${SLOWEST_ORDER}, ${MEAN} IS NOT NULL)) AS figure_1_tests_id_string,`,
        "    sum(health.total_duration_milliseconds_combined) AS figure_2_duration_milliseconds,",
        "    {generation: String} AS generation",
        "FROM combined_health AS health",
        "SETTINGS optimize_aggregation_in_order = 1",
        "",
      ].join("\n")
    );
  });

  test("sharing a statement, each figure's filters are its own aggregate's", () => {
    const [statement] = ofEachKind(REQUESTS["both code sources"]);
    const status = (index: number) =>
      `health.status IN {figure_${index}_filter_status: Array(String)}`;
    expect(outer(statement)).toBe(
      [
        "SELECT",
        `    countIf(${status(0)}) AS figure_0_count,`,
        `    maxIf(${MEAN}, ${status(1)}) AS figure_1_duration_milliseconds,`,
        `    toString(argMaxIf(health.tests_id, ${SLOWEST_ORDER}, ${MEAN} IS NOT NULL AND ${status(
          1
        )})) AS figure_1_tests_id_string,`,
        `    sumIf(health.total_duration_milliseconds_combined, ${status(
          2
        )}) AS figure_2_duration_milliseconds,`,
        "    {generation: String} AS generation",
        "FROM combined_health AS health",
        "SETTINGS optimize_aggregation_in_order = 1",
        "",
      ].join("\n")
    );
  });

  test("alone, a figure keeps the rows of its value filters and looks at the array in those", () => {
    const statements = ofEachKind(REQUESTS["every kind of filter"]);
    const paths = (index: number) =>
      `hasAny(health.workflow_paths_combined, {figure_${index}_filter_workflow_path: Array(String)})`;
    const selected = [
      `countIf(${paths(0)}) AS figure_0_count`,
      [
        `maxIf(${MEAN}, ${paths(1)}) AS figure_1_duration_milliseconds`,
        `toString(argMaxIf(health.tests_id, ${SLOWEST_ORDER}, ${MEAN} IS NOT NULL AND ${paths(
          1
        )})) AS figure_1_tests_id_string`,
      ].join(",\n    "),
      `sumIf(health.total_duration_milliseconds_combined, ${paths(
        2
      )}) AS figure_2_duration_milliseconds`,
    ];
    statements.forEach((statement, index) => {
      expect(outer(statement)).toBe(
        [
          "SELECT",
          `    ${selected[index]},`,
          "    {generation: String} AS generation",
          "FROM combined_health AS health",
          `WHERE health.status IN {figure_${index}_filter_status: Array(String)}`,
          "SETTINGS optimize_aggregation_in_order = 1",
          "",
        ].join("\n")
      );
    });
  });

  test("slowest names the test the list sorted by the mean shows first", () => {
    // The list a reader gets for the view orders by the mean, largest
    // first, then by the three ids, smallest first.
    const list = buildListQuery(REQUESTS["the slowest view"], null);
    expect(list.sql).toContain(
      "ORDER BY key_0 DESC NULLS LAST, key_1 ASC NULLS LAST, key_2 ASC NULLS LAST, key_3 ASC NULLS LAST"
    );
    for (const key of [
      "mean_passed_duration_milliseconds_combined AS key_0",
      "tests_id AS key_1",
      "environments_id AS key_2",
      "env_vars_id AS key_3",
    ]) {
      expect(list.sql).toContain(`        ${key}`);
    }
    // The figure is the largest by the mean and then by the test's id
    // turned around, so the smallest id wins a tie: the test of that first
    // row. The other two ids only order one test's rows, and are not read.
    const [statement] = ofEachKind(REQUESTS["the slowest view"]);
    const columns = figureColumns(1);
    expect(outer(statement)).toContain(
      `toString(argMaxIf(health.tests_id, (assumeNotNull(${MEAN}), bitNot(health.tests_id)), ${MEAN} IS NOT NULL)) AS ${columns.testsId}`
    );
    // Its duration is the largest mean, NULL when no row has one.
    expect(outer(statement)).toContain(`max(${MEAN}) AS ${columns.duration}`);
    expect(outer(statement)).not.toMatch(/environments_id|env_vars_id/);
  });

  test("a figure's columns are named by its position", () => {
    expect(figureColumns(4)).toEqual({
      count: "figure_4_count",
      duration: "figure_4_duration_milliseconds",
      testsId: "figure_4_tests_id_string",
    });
  });

  test("one code source is read without grouping, two are combined per configuration", () => {
    const [single] = ofEachKind(REQUESTS["the unhealthy view"]);
    expect(single.sql).not.toContain("GROUP BY");
    const [both] = ofEachKind(REQUESTS["both code sources"]);
    expect(both.sql).toContain(
      "GROUP BY tests_id, environments_id, env_vars_id"
    );
  });

  test("figures of requests that select different rows do not share a statement", () => {
    const statements = buildFigureStatements(
      [
        { kind: "count", query: listQuery({ status: ["failing"] }) },
        { kind: "count", query: listQuery({ window: "7d" }) },
        { kind: "count", query: listQuery({ ran_on: "pull_request" }) },
        { kind: "count", query: listQuery({ language: ["cpp"] }) },
        { kind: "count", query: listQuery({ status: ["flaky"] }) },
        // Neither the sort nor the page changes what is selected.
        { kind: "count", query: listQuery({ sort: "-runs", limit: "5" }) },
      ],
      GENERATION
    );
    expect(statements.map((statement) => statement.figures)).toEqual([
      [0, 4, 5],
      [1],
      [2],
      [3],
    ]);
  });

  test("the test record is one catalog row, read by its id with FINAL, at no refresh", () => {
    const { sql, params } = buildTestRecordQuery("13862921515559540007");
    expect(params).toEqual({ test_id: "13862921515559540007" });
    expect(sql).not.toContain("generation");
    expect(sql).toContain("FROM ci.tests AS test FINAL");
    expect(sql).toContain("WHERE test.id = {test_id: UInt64}");
    for (const column of [
      "tests_id_string",
      "repo",
      "file",
      "suite",
      "case_name",
      "declared_case_name",
      "language",
      "first_seen_at",
    ]) {
      expect(sql).toContain(` AS ${column}`);
    }
  });
});
