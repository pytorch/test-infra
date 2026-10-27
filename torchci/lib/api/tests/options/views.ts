import type { TestView } from "lib/api/tests/options/types";
import { DEFAULT_RAN_ON, DEFAULT_SORT } from "lib/api/tests/parameters";

const DEFAULT_SORT_PARAM = DEFAULT_SORT.join(",");

// Named queries of GET /api/tests, served with the options so the tests page
// offers them as chips and API callers can read them too. handler.test.ts
// parses each view's params with the list's own parameter definitions. The
// first view is the list's defaults. Only Blocking viable/strict sets a
// window; the others leave it to the reader.
export const TEST_VIEWS: readonly TestView[] = [
  {
    id: "least_healthy",
    label: "Least healthy",
    description:
      "The default. Failing tests first, then flaky, then healthy; within each, by failure rate, failed runs and most recent failure.",
    params: {
      ran_on: DEFAULT_RAN_ON.join(","),
      sort: DEFAULT_SORT_PARAM,
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
  },
  {
    id: "slowest",
    label: "Slowest",
    description: "Mean passing duration, slowest first.",
    params: {
      ran_on: "main",
      sort: "-mean_passed_duration_milliseconds",
    },
  },
  {
    id: "most_ci_time",
    label: "Most CI time",
    description: "Total time across all attempts, most first.",
    params: {
      ran_on: "main",
      sort: "-total_duration_milliseconds",
    },
  },
];
