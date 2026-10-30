import { testPagePath } from "lib/api/tests/pages/parameters";
import type { HealthWindow, RanOn } from "lib/api/tests/parameters";
import type { TestHealthEntry } from "lib/api/tests/types";
import {
  CELL_STATUSES,
  DEFAULT_GRID_TIME_BAR,
  gridUrlParams,
} from "lib/tests/grid";

// Where the list's rows lead: the links from /tests/[organization]/[repo]
// to a test's page, /tests/[organization]/[repo]/test/[test_id]. A row's
// cells follow one rule: text that describes the test, its environment,
// config and owners, narrows the list, and the test's own figures open the
// test. The name is the test's home, the canonical page with no
// parameters, so its URL is short and the same from every row of the test
// (testPagePath, defined with the page's parameters in
// lib/api/tests/pages/parameters.ts, where the API writes the same link as
// every test record's hud_url). The Health and duration cells are evidence
// links: a reader who clicks "Failing 92%" is asking to see the failures,
// so the link carries the list's window and code sources, which the figure
// was counted over, and names the row's configuration, which the page
// marks among the others (LanePin). Free of React, so the table and the
// tests can read it.

export { testPagePath };

// What the list is showing that an evidence link carries along.
export interface ListContext {
  window: HealthWindow;
  ranOn: readonly RanOn[];
}

// The test's page opened on the runs a row's figures were counted over,
// with the row's configuration marked; the page's defaults are left off,
// as the page leaves them off its own URL (gridUrlParams). A row whose
// environment or env var set the catalog lacks names no configuration.
export function testRunsHref(
  repo: string,
  entry: Pick<TestHealthEntry, "test" | "environment" | "env_vars">,
  context: ListContext
): string {
  const params = gridUrlParams({
    ranOn: context.ranOn,
    window: context.window,
    outcomes: CELL_STATUSES,
    timeBar: DEFAULT_GRID_TIME_BAR,
    commit: "",
    lane:
      entry.environment !== null && entry.env_vars !== null
        ? {
            environmentId: entry.environment.id,
            envVarsId: entry.env_vars.id,
          }
        : null,
  });
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(name, value);
    }
  }
  const path = testPagePath(repo, entry.test.id);
  const query = search.toString();
  return query === "" ? path : `${path}?${query}`;
}
