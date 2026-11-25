import { queryClickhouse } from "lib/api/tests/clickhouse";
import { readGeneration } from "lib/api/tests/list";
import { TestRow, toTest } from "lib/api/tests/mapping";
import type { TestView } from "lib/api/tests/options/types";
import { TEST_VIEWS } from "lib/api/tests/options/views";
import { testsPageLink } from "lib/api/tests/pages/links";
import { parseTestListParams, TestListQuery } from "lib/api/tests/parameters";
import type { TestSummaryQuery } from "lib/api/tests/summary/parameters";
import {
  buildFigureStatements,
  buildTestRecordQuery,
  figureColumns,
  FiguresStatement,
  Statement,
} from "lib/api/tests/summary/query";
import type { TestSummary, TestViewFigure } from "lib/api/tests/summary/types";
import { timed } from "lib/api/tests/timed";

// How long the server's query cache keeps the figures. Every statement of
// theirs reads a whole health partition, and every reader of the tests page
// asks for the same ones, so the partitions are read once in this time for a
// window and a choice of languages, whoever asks. The health table changes
// every 15 minutes, and a statement's answer is kept for the refresh it was
// asked for at (query.ts), so none kept from before a refresh is given after
// it.
export const FIGURES_KEPT_SECONDS = 60;

// The list request for the given list parameters, spelled as a URL spells
// them, in the window and languages the summary was asked for, which
// parameters that set their own override. Read by the list's own parser, so
// it is a request GET /api/tests accepts, normalized as the list normalizes
// it. No parameters is the list's defaults: the page the figures sit on.
function listQuery(
  query: TestSummaryQuery,
  params: TestView["params"] = {}
): TestListQuery {
  const parsed = parseTestListParams({
    repo: query.repo,
    window: query.window,
    ...(query.language === undefined ? {} : { language: query.language }),
    ...params,
  });
  if (!parsed.success) {
    throw new Error(
      `Not a request GET /api/tests accepts: ${parsed.error.message}`
    );
  }
  const { cursor: _cursor, ...list } = parsed.data;
  return list;
}

// The list request a view stands for in the summary's window and languages.
// The tests page chooses a view the same way (chooseView in
// lib/tests/views.ts), so this is what choosing the view shows, and the
// page a figure links.
export function viewListQuery(
  view: TestView,
  query: TestSummaryQuery
): TestListQuery {
  return listQuery(query, view.params);
}

// The list request a view's figure is read over: the view's, with the
// filters its figure adds. For most views that is the view's own request
// and the figure is of everything the view lists; the first view lists
// every entry and its figure counts the unhealthy ones, failing or flaky,
// which that list leads with.
export function figureListQuery(
  view: TestView,
  query: TestSummaryQuery
): TestListQuery {
  return listQuery(query, { ...view.params, ...view.figure.params });
}

// A statement of the summary, its answer kept by the server for
// FIGURES_KEPT_SECONDS. None runs in the heavy workload: measured, a
// summary's statements take about one and a half CPU-seconds together for
// the default request and three and a half for 14 days, and the rule is to
// tag what takes about ten (app/api/README.md, Heavy queries).
function read<Row>(statement: Statement, queryId: string) {
  return timed(
    queryClickhouse(statement.sql, statement.params, queryId, true, {
      query_cache_ttl: FIGURES_KEPT_SECONDS,
    }) as Promise<Row[]>
  );
}

const QUERY_ID = "api_tests_summary_";

// The statements that answer every view's figure in the summary's window
// and languages, asked for at the given health refresh, each with the views
// it answers and the query ID it is sent under, which names them.
export function summaryStatements(
  query: TestSummaryQuery,
  generation: string
): { statement: FiguresStatement; views: TestView[]; queryId: string }[] {
  return buildFigureStatements(
    TEST_VIEWS.map((view) => ({
      kind: view.figure.kind,
      query: figureListQuery(view, query),
    })),
    generation
  ).map((statement) => {
    const views = statement.figures.map((index) => TEST_VIEWS[index]);
    return {
      statement,
      views,
      queryId: `${QUERY_ID}${views.map((view) => view.id).join("__")}`,
    };
  });
}

// The figures one statement answers, each with its view's position, and the
// milliseconds its queries took, each rounded.
async function readFigures(
  { statement, queryId }: ReturnType<typeof summaryStatements>[number],
  query: TestSummaryQuery
): Promise<{ figures: [number, TestViewFigure][]; duration_ms: number }> {
  const answered = await read<Record<string, number | string | null>>(
    statement,
    queryId
  );
  // One row of aggregates, which a server that answers with none stands for
  // too: nothing counted.
  const row = answered.result[0] ?? {};
  let duration_ms = answered.duration_ms;
  const figures = await Promise.all(
    statement.figures.map(async (index): Promise<[number, TestViewFigure]> => {
      const view = TEST_VIEWS[index];
      const columns = figureColumns(index);
      const figure: TestViewFigure = {
        id: view.id,
        kind: view.figure.kind,
        window: figureListQuery(view, query).window,
        count: null,
        duration_milliseconds: null,
        test: null,
        // The view's own page, which a figure of fewer entries sits above
        // too.
        hud_url: testsPageLink(viewListQuery(view, query)),
      };
      switch (view.figure.kind) {
        case "count":
          return [index, { ...figure, count: Number(row[columns.count] ?? 0) }];
        case "total_duration":
          return [
            index,
            {
              ...figure,
              duration_milliseconds: Number(row[columns.duration] ?? 0),
            },
          ];
        case "slowest": {
          const duration = row[columns.duration] ?? null;
          if (duration === null) return [index, figure];
          // The catalog row of that one test, by its ID: joined in the
          // same statement, the whole catalog would be read to name one
          // test.
          const test = await read<TestRow>(
            buildTestRecordQuery(String(row[columns.testsId])),
            `${QUERY_ID}${view.id}_test`
          );
          duration_ms += test.duration_ms;
          const record = test.result[0];
          return [
            index,
            {
              ...figure,
              duration_milliseconds: Number(duration),
              test: record === undefined ? null : toTest(record),
            },
          ];
        }
      }
    })
  );
  return { figures, duration_ms };
}

// How a repository's tests stand: the health table's refresh timestamp,
// one row read, and then the figure of every view, their statements sent
// together and each asked for at that refresh, so the server answers with
// no figure it kept from the refresh before. A refresh that lands while the
// figures are read is the one race left: a figure can then be of the refresh
// after the one reported, as an empty page of the list can (list.ts). A
// repository the catalog does not know has zero counts and no slowest test,
// as its list is an empty page.
export async function summarizeTests(
  query: TestSummaryQuery
): Promise<TestSummary> {
  const refreshed = await timed(readGeneration());
  const answers = await Promise.all(
    summaryStatements(query, refreshed.result).map((statement) =>
      readFigures(statement, query)
    )
  );
  // Every view is answered by exactly one statement.
  const figures = new Map(answers.flatMap((answer) => answer.figures));
  return {
    views: TEST_VIEWS.map((_, index) => figures.get(index) as TestViewFigure),
    hud_url: testsPageLink(listQuery(query)),
    refreshed_at: refreshed.result || null,
    query_duration_ms:
      refreshed.duration_ms +
      answers.reduce((sum, { duration_ms }) => sum + duration_ms, 0),
  };
}
