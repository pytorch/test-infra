import { CI_DATABASE } from "lib/api/tests/database";
import type { TestView } from "lib/api/tests/options/types";
import type { TestListQuery } from "lib/api/tests/parameters";
import {
  buildHealthFilters,
  buildSelection,
  withoutHealthFilters,
} from "lib/api/tests/query";

// The figures of GET /api/tests/summary, read over what list requests
// select (buildSelection in ../query.ts): the list's own combined_health
// rows and its own predicates on them, so a figure is of exactly the rows
// the list would return for the same parameters, with no page chosen, no
// sort and no catalog joined.
//
// Figures over the same rows share a statement. Two list requests that
// differ only in their filters on the combined rows, the status and the
// workflow paths, select the same combined_health rows before those
// filters. One statement reads those rows once and answers each figure with
// an aggregate over the rows its own filters keep (countIf, sumIf,
// argMaxIf), where a statement per figure read the partition and matched it
// against the catalog once for each.
//
// A figure whose filters search an array, the workflow paths, has a
// statement to itself, and that statement keeps only the rows the figure's
// other filters keep (WHERE) before the aggregate looks at the array: the
// status needs three counts per row, the paths an array per row, so the
// arrays are read only where a row of that status is. Written as one WHERE,
// the server tests the array first, on every row of the partition.
//
// The server's query cache keeps each statement's answer for a minute
// (summary.ts), and the health table is replaced whole every 15 minutes. So
// that an answer kept from one refresh is never given after the next, each
// statement is asked for at a refresh: the health table's refresh timestamp,
// read just before, is bound as {generation: String} and selected back as a
// constant. The cache keys an answer by the statement with its parameters
// bound, so a new refresh is a statement it has no answer for yet. The
// constant chooses no rows: the figures are of whatever the health table
// holds when the statement runs, that refresh or one that landed since.
//
// Measured on production on 2026-11-24 (query-validation.md): the default
// request's six figures took a median of 831 ms as a statement each, sent
// together, and take 338 ms as these three, for 774 ms of server time
// instead of 2,013; every figure equals the statement-per-figure baseline.

export interface Statement {
  sql: string;
  params: Record<string, unknown>;
}

// What a figure says of the rows it is read over: how many there are, the
// slowest of them, or the machine time all of them took.
export type FigureKind = TestView["figure"]["kind"];

export interface FigureRequest {
  kind: FigureKind;
  // The list request the figure is read over.
  query: TestListQuery;
}

// One statement and the figures it answers, each by its position in the
// requests given: figure i is answered in the columns figureColumns(i)
// names, of the statement's one row.
export interface FiguresStatement extends Statement {
  figures: number[];
}

// The columns that answer the figure at a position: a count's count; a total
// duration's duration; a slowest's duration, NULL when no row has one, and
// the ID of its test as a decimal string, which can exceed 2^53.
export function figureColumns(index: number) {
  return {
    count: `figure_${index}_count`,
    duration: `figure_${index}_duration_milliseconds`,
    testsId: `figure_${index}_tests_id_string`,
  };
}

// The refresh a statement is asked for at, as it selects it.
const GENERATION_SQL = "{generation: String} AS generation";

const MEAN_SQL = "health.mean_passed_duration_milliseconds_combined";

// What the slowest row is the largest by: its mean, then its test's ID,
// smallest first. The list orders by -mean_passed_duration_milliseconds with
// the three IDs ascending to break ties, and bitNot turns an unsigned ID's
// order around, so the largest pair is of the test that list shows first.
// The figure names the test alone, so the environment and env var set IDs,
// which only order one test's rows among themselves, are not read.
const SLOWEST_ORDER_SQL = `(assumeNotNull(${MEAN_SQL}), bitNot(health.tests_id))`;

// An aggregate over the combined rows the predicates keep: all of them when
// there are none.
function over(
  aggregate: string,
  argument: string | null,
  predicates: string[]
): string {
  const condition = predicates.join(" AND ");
  if (argument === null) {
    return predicates.length === 0
      ? `${aggregate}()`
      : `${aggregate}If(${condition})`;
  }
  return predicates.length === 0
    ? `${aggregate}(${argument})`
    : `${aggregate}If(${argument}, ${condition})`;
}

// The columns that answer one figure, over the rows its filters keep.
function figureSql(
  kind: FigureKind,
  index: number,
  predicates: string[]
): string[] {
  const columns = figureColumns(index);
  switch (kind) {
    // How many entries the list returns for the request over all its pages:
    // one per configuration the selection keeps. Every health row's test is
    // in the catalog, which is what matched it, and a missing environment
    // or env var set costs the list no row, so the combined rows are the
    // entries.
    case "count":
      return [`${over("count", null, predicates)} AS ${columns.count}`];
    // The machine time the attempts of every entry took, summed: 0 when the
    // request selects nothing.
    case "total_duration":
      return [
        `${over(
          "sum",
          "health.total_duration_milliseconds_combined",
          predicates
        )} AS ${columns.duration}`,
      ];
    // The entry with the largest mean passed duration, the one the list
    // sorted by it shows first. An entry without a passed run has no mean,
    // sorts last there and is left out here: the duration is NULL when none
    // has one, and the ID then names no test.
    case "slowest":
      return [
        `${over("max", MEAN_SQL, predicates)} AS ${columns.duration}`,
        `toString(${over("argMax", `health.tests_id, ${SLOWEST_ORDER_SQL}`, [
          `${MEAN_SQL} IS NOT NULL`,
          ...predicates,
        ])}) AS ${columns.testsId}`,
      ];
  }
}

// The statements that answer the given figures, each asked for at the given
// refresh: one for the figures over each selection of combined rows, and one
// for each figure that searches an array. Every figure is answered by
// exactly one of them.
export function buildFigureStatements(
  requests: FigureRequest[],
  generation: string
): FiguresStatement[] {
  interface Group {
    selection: ReturnType<typeof buildSelection>;
    params: Record<string, unknown>;
    figures: {
      index: number;
      kind: FigureKind;
      filters: ReturnType<typeof buildHealthFilters>;
    }[];
  }
  const groups = new Map<string, Group>();
  requests.forEach(({ kind, query }, index) => {
    // What the request selects before its filters on the combined rows.
    const selection = buildSelection(withoutHealthFilters(query));
    const params: Record<string, unknown> = {};
    const filters = buildHealthFilters(
      query,
      params,
      `figure_${index}_filter_`
    );
    const selected = JSON.stringify([
      selection.combinedHealthSql,
      selection.params,
    ]);
    // A figure that searches an array shares its statement with no other.
    const key = filters.arrays.length === 0 ? selected : `${index}:${selected}`;
    const group = groups.get(key) ?? {
      selection,
      params: { ...selection.params },
      figures: [],
    };
    groups.set(key, group);
    Object.assign(group.params, params);
    group.figures.push({ index, kind, filters });
  });
  return Array.from(groups.values(), ({ selection, params, figures }) => {
    // Alone, a figure needs no row its value filters drop: they are the
    // statement's WHERE, and its aggregate looks at an array only in the
    // rows they keep. With others, each figure's filters are its
    // aggregate's own, over every row of the selection.
    const alone = figures.length === 1;
    const kept = alone ? figures[0].filters.values : [];
    const columns = figures.flatMap(({ index, kind, filters }) =>
      figureSql(kind, index, alone ? filters.arrays : filters.values)
    );
    return {
      figures: figures.map(({ index }) => index),
      params: { ...params, generation },
      sql: `
WITH combined_health AS (${selection.combinedHealthSql})
SELECT
    ${columns.join(",\n    ")},
    ${GENERATION_SQL}
FROM combined_health AS health${
        kept.length === 0 ? "" : `\nWHERE ${kept.join("\n    AND ")}`
      }
SETTINGS optimize_aggregation_in_order = 1
`,
    };
  });
}

// One test's catalog row by its ID, the table's sort key, with FINAL so the
// earliest first_seen_at of its stored rows is the one read. The catalog is
// not replaced with the health table, so this is asked for at no refresh.
export function buildTestRecordQuery(testId: string): Statement {
  return {
    params: { test_id: testId },
    sql: `
SELECT
    toString(test.id) AS tests_id_string,
    test.repo AS repo,
    test.file AS file,
    test.suite AS suite,
    test.case_name AS case_name,
    test.declared_case_name AS declared_case_name,
    test.language AS language,
    test.first_seen_at AS first_seen_at
FROM ${CI_DATABASE}.tests AS test FINAL
WHERE test.id = {test_id: UInt64}
`,
  };
}
