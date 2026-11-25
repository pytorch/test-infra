import type { TestOptions, TestView } from "lib/api/tests/options/types";
import {
  resolveTestsQuery,
  TestsQuery,
  testsQueryFromUrl,
  testsUrlParams,
} from "lib/tests/table";

// The named views GET /api/tests/options serves, as the tests page offers
// them in the band above the table. A view's params are list parameters
// spelled as a URL spells them, so the page reads one exactly as it reads
// its own URL: as written (testsQueryFromUrl), then checked against the
// options (resolveTestsQuery). Nothing here knows what any view asks for.

// The views the options offer. Options served before views existed, which a
// browser's cache can hold for a while after a deploy, offer none, and the
// page shows no views.
export function viewsOf(options: Partial<Pick<TestOptions, "views">>) {
  return options.views ?? [];
}

// The health statuses a view's cell is about, in the order the view names
// them: what the cell takes its dots from, one in each status's color. The
// statuses the view's figure counts when the figure narrows the view, as
// the first view's does to the failing and the flaky, else the ones the
// view itself narrows the list to; none for a view of every status. Read
// off the view's own parameters, so a view added to the API gets its dots
// with no change here.
export function viewStatuses(view: {
  params: TestView["params"];
  figure?: Partial<Pick<TestView["figure"], "params">>;
}): string[] {
  return [view.figure?.params?.status ?? view.params.status ?? []].flat();
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

// Whether two queries are the same page: the URLs the page would write for
// them are the same.
function sameQuery(
  left: TestsQuery,
  right: TestsQuery,
  options: TestOptions
): boolean {
  return (
    JSON.stringify(urlParamsOf(left, options)) ===
    JSON.stringify(urlParamsOf(right, options))
  );
}

// The query a chosen view asks for, from a clean start, in the window and
// the languages the reader is in unless the view sets its own: the two of
// the page's choices that a view can leave to the reader, and the two
// GET /api/tests/summary reads its figures over, so a view's figure is the
// figure of what choosing it shows. The first view, the list's defaults,
// sets the default window, and Blocking viable/strict its own: choosing
// either moves the page to its window.
export function chooseView(
  query: TestsQuery,
  view: TestView,
  options: TestOptions
): TestsQuery {
  const chosen = viewQuery(view, options);
  return {
    ...chosen,
    window: "window" in view.params ? chosen.window : query.window,
    languages: "language" in view.params ? chosen.languages : query.languages,
  };
}

// The ids of the views the page is showing: each view that, chosen now,
// would change nothing. The mark is exact: a filter, a search, a sort or a
// code source the view does not ask for is no longer the view, so its cell
// does not stay marked over a table that shows something else. The window
// and the languages are the reader's, so changing them keeps a view marked
// unless the view sets its own, as the first view does: it is the list's
// defaults, their window included, so the page opens with it marked and the
// same table in another window marks nothing.
export function activeViewIds(
  query: TestsQuery,
  options: TestOptions
): string[] {
  return viewsOf(options)
    .filter((view) =>
      sameQuery(chooseView(query, view, options), query, options)
    )
    .map((view) => view.id);
}

// The marked views a second click can clear: those whose own parameters,
// back at their defaults, make another page. The view that is the list's
// defaults has nothing to give back: it is where clearing any other view
// leads, so its marked cell is not a way out of anything.
export function clearableViewIds(
  query: TestsQuery,
  options: TestOptions
): string[] {
  return viewsOf(options)
    .filter(
      (view) =>
        sameQuery(chooseView(query, view, options), query, options) &&
        !sameQuery(withoutView(query, view, options), query, options)
    )
    .map((view) => view.id);
}

// The query with a view's own parameters back at their defaults and
// everything else kept, for when its marked cell is clicked again. A marked
// view is exact, so what is kept is the reader's window and languages: the
// list's defaults in them, which in the default window is the page a reader
// arrives on, the first view, and in another window is no view.
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
