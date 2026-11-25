import type { TestView } from "lib/api/tests/options/types";
import type { TestSummary, TestViewFigure } from "lib/api/tests/summary/types";
import { durationLabel, integerLabel, TestsQuery } from "lib/tests/table";

// The figures of the band above the tests table: what
// GET /api/tests/summary answers each view with, as the band's cells set
// them. Free of React, so the band and the tests can read it. The page
// knows the three kinds of figure, which is how to set a number; what a
// view asks for and what its figure is called stay the API's.

// The request for the figures: the repository and the two title choices the
// views leave to the reader, the window and the languages, named
// explicitly, as the list's request names them. A view the reader chooses
// changes neither, so the figures are asked for once per window and choice
// of languages and stay put while the reader moves between views.
export function testsSummaryApiUrl(
  repo: string,
  query: Pick<TestsQuery, "window" | "languages">
): string {
  const params = new URLSearchParams({ repo, window: query.window });
  for (const language of query.languages) {
    params.append("language", language);
  }
  return `/api/tests/summary?${params.toString()}`;
}

// A view's figure in a summary: none before the summary arrives, and none
// for a view the summary does not answer, as when the options and the
// summary come from either side of a deploy.
export function figureOf(
  summary: Pick<TestSummary, "views"> | undefined,
  view: Pick<TestView, "id">
): TestViewFigure | undefined {
  return summary?.views.find((figure) => figure.id === view.id);
}

// Machine time summed over every test, which runs to thousands of hours:
// whole hours from ten up, "1,240 h"; below that as a duration is said
// elsewhere on the page, "4 h 22 min", "32.3 min".
const TEN_HOURS_MILLISECONDS = 10 * 60 * 60 * 1000;
export function totalDurationLabel(milliseconds: number): string {
  return milliseconds >= TEN_HOURS_MILLISECONDS
    ? `${integerLabel(Math.round(milliseconds / (60 * 60 * 1000)))} h`
    : durationLabel(milliseconds);
}

// A figure as its cell sets it: the number, large, and its unit, smaller
// beside it; `none` for a count of zero, which the cell sets quietly.
export interface FigureText {
  value: string;
  unit?: string;
  none: boolean;
}

// A duration's label as a number and its unit, "21.6" and "min"; one in
// hours and minutes, "4 h 22 min", is all number.
function durationText(label: string): Pick<FigureText, "value" | "unit"> {
  const parts = label.split(" ");
  return parts.length === 2
    ? { value: parts[0], unit: parts[1] }
    : { value: label };
}

// The figure's text, or null when it has none to show: a slowest figure
// when nothing passed. A count is grouped in threes, "1,502"; the slowest
// mean reads as the table's Mean Passed Duration cell does, since it is the
// first row that view lists; the machine time is in hours.
export function figureText(figure: TestViewFigure): FigureText | null {
  switch (figure.kind) {
    case "count":
      return figure.count === null
        ? null
        : { value: integerLabel(figure.count), none: figure.count === 0 };
    case "slowest":
      return figure.duration_milliseconds === null
        ? null
        : {
            ...durationText(durationLabel(figure.duration_milliseconds)),
            none: false,
          };
    case "total_duration":
      return figure.duration_milliseconds === null
        ? null
        : {
            ...durationText(totalDurationLabel(figure.duration_milliseconds)),
            none: figure.duration_milliseconds === 0,
          };
    default:
      // A kind this page does not know, from a newer API.
      return null;
  }
}

// A test's name as pytest spells it, "file::suite::case_name", the suite
// left out for a module-level function.
function testName(test: NonNullable<TestViewFigure["test"]>): string {
  return [test.file, test.suite, test.case_name]
    .filter((part) => part !== "")
    .join("::");
}

// What a cell sets under its figure: the name of the slowest test when the
// figure has one, the case alone since the cell is narrow, with the whole
// name for its tooltip; else the view's own caption.
export function figureCaption(
  view: { figure?: Partial<TestView["figure"]> },
  figure: TestViewFigure | undefined
): { text: string; name?: string } {
  if (figure?.kind === "slowest" && figure.test !== null) {
    return { text: figure.test.case_name, name: testName(figure.test) };
  }
  // Options from before the views had figures, which a browser's cache can
  // hold for a while after a deploy, have no caption.
  return { text: view.figure?.caption ?? "" };
}

// The figure said in a sentence, for the cell's tooltip under the view's
// description: what the number is a number of, and over which window, as
// the options label it, "12 hours". A count is of the table's rows, one
// per test, environment and test config, which the sentence says, since
// "20 failing" reads as twenty tests.
export function figureSentence(
  figure: TestViewFigure,
  windowLabel: string
): string | null {
  const within = `in the last ${windowLabel}`;
  switch (figure.kind) {
    case "count":
      return figure.count === null
        ? null
        : `${integerLabel(figure.count)} ${
            figure.count === 1 ? "row" : "rows"
          } ${within}, one per test, environment and test config.`;
    case "slowest":
      return figure.duration_milliseconds === null
        ? `No test passed ${within}.`
        : `${
            figure.test === null ? "The slowest test" : testName(figure.test)
          } averaged ${durationLabel(
            figure.duration_milliseconds
          )} a passed run ${within}.`;
    case "total_duration":
      return figure.duration_milliseconds === null
        ? null
        : `${totalDurationLabel(
            figure.duration_milliseconds
          )} of machine time ${within}, every attempt counted.`;
    default:
      return null;
  }
}
