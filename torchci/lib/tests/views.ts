import type { TestOptions, TestView } from "lib/api/tests/options/types";
import {
  resolveTestsQuery,
  TestsQuery,
  testsQueryFromUrl,
  testsUrlParams,
} from "lib/tests/table";

// The named views GET /api/tests/options serves, as the tests page offers
// them above the table. A view's params are list parameters spelled as a
// URL spells them, so the page reads one exactly as it reads its own URL:
// as written (testsQueryFromUrl), then checked against the options
// (resolveTestsQuery). Nothing here knows what any view asks for.

// The views the options offer. Options served before views existed, which a
// browser's cache can hold for a while after a deploy, offer none, and the
// page shows no views.
export function viewsOf(options: Partial<Pick<TestOptions, "views">>) {
  return options.views ?? [];
}

// The query a view asks for, resolved like a page URL: the defaults filled
// in, a value the options do not offer dropped.
function viewQuery(view: TestView, options: TestOptions): TestsQuery {
  return resolveTestsQuery(testsQueryFromUrl(view.params), options);
}

// A query's URL parameters by name, each in canonical order and undefined at
// its default, so two queries agree on a parameter when these are equal.
function urlParamsOf(query: TestsQuery, options: TestOptions) {
  return testsUrlParams(query, options) as Record<
    string,
    string | string[] | undefined
  >;
}

// The ids of the views the page is showing: each view whose own parameters
// all hold. Anything a view leaves out, another filter, a search, is a
// refinement of it, so its chip stays chosen; changing a parameter the view
// sets leaves it. Of two views that hold, one setting every parameter the
// other sets is the more specific and shown alone: Blocking viable/strict
// over the defaults it starts from.
export function activeViewIds(
  query: TestsQuery,
  options: TestOptions
): string[] {
  const current = urlParamsOf(query, options);
  const holding = viewsOf(options).filter((view) => {
    const asked = urlParamsOf(viewQuery(view, options), options);
    return Object.keys(view.params).every(
      (name) => JSON.stringify(current[name]) === JSON.stringify(asked[name])
    );
  });
  const names = (view: TestView) => Object.keys(view.params);
  return holding
    .filter(
      (view) =>
        !holding.some(
          (other) =>
            names(other).length > names(view).length &&
            names(view).every((name) => name in other.params)
        )
    )
    .map((view) => view.id);
}

// The query a chosen view asks for, from a clean start, in the window the
// reader is in unless the view sets its own.
export function chooseView(
  query: TestsQuery,
  view: TestView,
  options: TestOptions
): TestsQuery {
  const chosen = viewQuery(view, options);
  return "window" in view.params ? chosen : { ...chosen, window: query.window };
}

// The query with a view's own parameters back at their defaults and every
// refinement kept, for when its chosen chip is clicked again.
export function withoutView(
  query: TestsQuery,
  view: TestView,
  options: TestOptions
): TestsQuery {
  const params = urlParamsOf(query, options);
  for (const name of Object.keys(view.params)) {
    params[name] = undefined;
  }
  return resolveTestsQuery(testsQueryFromUrl(params), options);
}
