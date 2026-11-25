import { WINDOW_LABELS } from "lib/api/tests/options/labels";
import type { TestView } from "lib/api/tests/options/types";
import {
  DEFAULT_RAN_ON,
  DEFAULT_SORT,
  DEFAULT_WINDOW,
} from "lib/api/tests/parameters";

const DEFAULT_SORT_PARAM = DEFAULT_SORT.join(",");
// The default window as the options label it, "3 hours".
const DEFAULT_WINDOW_LABEL = WINDOW_LABELS[DEFAULT_WINDOW];

// Named queries of GET /api/tests, served with the options so the tests page
// offers them as the cells of its band and API callers can read them too.
// handler.test.ts parses each view's params with the list's own parameter
// definitions. The first view is the list's defaults, their window
// included: the page a reader arrives on, so that page shows a view too, and
// the same table in another window does not. Blocking viable/strict sets a
// window of its own as well. Every other view narrows or reorders the
// defaults and leaves the window to the reader, and every view leaves the
// languages.
//
// Each view names the figure that says how its question stands, which
// GET /api/tests/summary reads for all of them (summary/summary.ts): how
// many entries the view lists, the slowest of them, or the machine time all
// of them took. A figure's own params narrow what it is of. The caption is
// set under the figure, so it says what the label leaves out and stays a
// few words long.
export const TEST_VIEWS: readonly TestView[] = [
  {
    // The defaults list every test, the unhealthy ones first: the failing,
    // then the flaky. A view of those alone showed the same first page as
    // the defaults, so choosing it changed nothing a reader could see and
    // the page opened with no view marked over a table that led with them.
    // The view is the defaults; the figure counts the unhealthy ones, the
    // rows the table begins with before its first healthy one. It was named
    // Failing, and counted the failing rows alone, until 2026-11-24: the
    // table under it is not of failing tests, it is of every test with the
    // unhealthy ones first, and flaky is unhealthy too.
    //
    // The view names the default window. Without it the view was the
    // defaults in whatever window the page was in: its cell stayed marked
    // at 12 hours or 7 days, and choosing it after Blocking viable/strict
    // had set 12 hours left the page there, marked as the default table.
    // The default table is the last 3 hours, so the view is too: choosing
    // it returns to them, no other window marks it, and its figure is of
    // them whatever the window, which is why the caption says so.
    id: "unhealthy",
    label: "Unhealthy",
    description: `The default: the last ${DEFAULT_WINDOW_LABEL}, failing tests first, then flaky, then healthy; within each, by failure rate, failed runs and most recent failure. The figure counts the unhealthy rows, failing or flaky: a run had a failed attempt.`,
    params: {
      window: DEFAULT_WINDOW,
      ran_on: DEFAULT_RAN_ON.join(","),
      sort: DEFAULT_SORT_PARAM,
    },
    figure: {
      kind: "count",
      caption: `failing or flaky, ${DEFAULT_WINDOW_LABEL}`,
      params: { status: ["failing", "flaky"] },
    },
  },
  {
    // update-viablestrict.yml in pytorch/pytorch requires the pull, trunk,
    // lint and docs-build workflows, matched by full name; lint and
    // docs-build run no tests.
    id: "blocking_viable_strict",
    label: "Blocking viable/strict",
    description:
      "Failing tests in pull and trunk on main, last 12 hours. Counts include other workflows (e.g. periodic) and unstable jobs.",
    params: {
      window: "12h",
      ran_on: "main",
      sort: DEFAULT_SORT_PARAM,
      status: ["failing"],
      workflow_path: [
        ".github/workflows/pull.yml",
        ".github/workflows/trunk.yml",
      ],
    },
    figure: { kind: "count", caption: "pull and trunk, 12 hours", params: {} },
  },
  {
    id: "flaky_main",
    label: "Flaky on main",
    description: "Passed on retry. Most retried first.",
    params: {
      ran_on: "main",
      status: ["flaky"],
      sort: "-flaky_runs,-flaky_rate",
    },
    figure: { kind: "count", caption: "passed on retry", params: {} },
  },
  {
    id: "flaky_pull_requests",
    label: "Flaky on PRs",
    description: "Passed on retry on PRs. Most retried first.",
    params: {
      ran_on: "pull_request",
      status: ["flaky"],
      sort: "-flaky_runs,-flaky_rate",
    },
    figure: { kind: "count", caption: "passed on retry", params: {} },
  },
  {
    id: "slowest",
    label: "Slowest",
    description: "Mean passing duration, slowest first.",
    params: {
      ran_on: "main",
      sort: "-mean_passed_duration_milliseconds",
    },
    figure: { kind: "slowest", caption: "mean passed duration", params: {} },
  },
  {
    id: "most_ci_time",
    label: "Most CI time",
    description: "Total time across all attempts, most first.",
    params: {
      ran_on: "main",
      sort: "-total_duration_milliseconds",
    },
    figure: {
      kind: "total_duration",
      caption: "of tests, all attempts",
      params: {},
    },
  },
];
