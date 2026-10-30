import type { GridSortModel } from "@mui/x-data-grid";
import type { TestOptions } from "lib/api/tests/options/types";
import {
  decodePageQuery,
  PageQueryValues,
  pageUrlParams,
  TESTS_PAGE_PARAMETER_DEFINITIONS,
  TestsPageParameterName,
} from "lib/api/tests/pages/parameters";
import type {
  HealthWindow,
  RanOn,
  TestLanguage,
} from "lib/api/tests/parameters";
import { DEFAULT_SORT } from "lib/api/tests/parameters";
import {
  facetChoice,
  FacetValues,
  labelOf,
  menuOrder,
  NAME_FILTERS,
  NameFilterValues,
  noFacetValues,
  noNameFilterValues,
  phraseList,
  TESTS_FACETS,
} from "lib/tests/facets";
import { COLUMN_HEADER_HEIGHT } from "lib/tests/layout";
import type { UrlQuery } from "lib/tests/url";

// The tests table on /tests/[organization]/[repo] sorts, filters and pages
// on the server through GET /api/tests. This is the glue between the page's
// state and that API's query parameters, kept free of React so it can be
// tested as plain functions. The parameters the page reads from its URL are
// the list's own definitions, picked by name in
// lib/api/tests/pages/parameters.ts, so each is spelled, encoded and
// defaulted as the API spells it and the OpenAPI document lists the page
// with them; the choices a reader makes, their labels and the catalogs'
// values arrive at run time from GET /api/tests/options, so nothing here
// spells out a catalog value.

export const TESTS_PAGE_SIZES: readonly number[] = [25, 50, 100];
export const DEFAULT_TESTS_PAGE_SIZE = 25;

// Each sortable column of the table and the API sort fields, in order, that
// sorting by it means. A header click sorts every field the same way and the
// API orders by them left to right.
export const TESTS_TABLE_SORT_FIELDS: Record<string, readonly string[]> = {
  name: ["file", "suite", "case_name"],
  // Worst first by what makes a test unhealthy: the status, since a failure
  // that survives its retries makes CI red while flakiness only costs
  // retries, then the share of runs with a failing attempt, the rate the
  // cell shows, then how many runs failed, then the newest failure first,
  // so among equal rates and counts a failure an hour old outranks one from
  // the morning. Every failing or flaky row has a failure time, so the last
  // two fields order the healthy rows, which have none: the most skipped
  // first, then the slowest. Ascending is healthiest first: the healthy
  // tests, least skipped and fastest first, then the flaky, then the
  // failing. The API puts configurations without a run, which have no
  // status rank and no rates, last either way.
  health: [
    "status",
    "failure_rate",
    "failed_runs",
    "last_failed_at",
    "skip_rate",
    "mean_passed_duration_milliseconds",
  ],
  // Like with like: what torch was built for, then the device, the Python,
  // then the platform details, in the order the cell sets them.
  environment: [
    "accelerator",
    "accelerator_version",
    "device_name",
    "device_count",
    "python_version",
    "os",
    "os_version",
    "cpu_architecture",
    "cpu_capability",
    "cc_compiler",
    "cc_compiler_version",
  ],
  test_config: ["test_config"],
  mean_passed_duration_milliseconds: ["mean_passed_duration_milliseconds"],
  // The API orders by the alphabetically first label and puts unowned tests
  // last either way.
  owners: ["owner"],
  last_run_at: ["last_run_at"],
};

// The API's own default sort, which the page leaves off its URL. It is the
// Health header's chain, worst first, so a fresh page opens on the failing
// tests with the arrow on that header.
export const DEFAULT_TESTS_SORT = DEFAULT_SORT.join(",");

// What a page URL asks for, as written: the sort, and the choices
// unchecked. The options say what they mean (resolveTestsQuery).
export interface TestsUrlQuery {
  // The API sort parameter.
  sort: string;
  // Absent means the API's default.
  window: string | undefined;
  // Empty means the API's default.
  ranOn: string[];
  // Empty means the API's default, all languages.
  languages: string[];
  // The facet filters, each empty for the API's default, no filter.
  filters: FacetValues;
  // The exact filters on the test's name, each empty for none.
  nameFilters: NameFilterValues;
  // Text the names are searched for; empty for none.
  search: string;
}

// What the page asks the API for besides the repository and the page: the
// URL's query resolved against the options, so every value is one the API
// offers, in menu order, with the defaults filled in.
export interface TestsQuery {
  sort: string;
  window: HealthWindow;
  // Never empty.
  ranOn: RanOn[];
  // Empty for all of them.
  languages: TestLanguage[];
  // Each empty for no filter on that facet.
  filters: FacetValues;
  // Each empty for no filter on that part of the name. Taken as written,
  // once each: the API matches them exactly, and only a URL sets them.
  nameFilters: NameFilterValues;
  // Empty for no search. Taken as written: the API reads it literally.
  search: string;
}

// The code sources as the title's sentence says them.
export function ranOnPhrase(
  ranOn: readonly RanOn[],
  options: TestOptions
): string {
  return phraseList(
    menuOrder(ranOn, options.ran_on.values).map((source) =>
      labelOf(source, options.ran_on.values)
    )
  );
}

// The languages as the title's sentence says them; none chosen means all.
export function languagesPhrase(
  languages: readonly TestLanguage[],
  options: TestOptions
): string {
  return languages.length === 0
    ? "all languages"
    : phraseList(
        menuOrder(languages, options.language.values).map((language) =>
          labelOf(language, options.language.values)
        )
      );
}

// The query a page URL asks for, as written, read through the page's
// parameter definitions: ran_on may be comma-separated or repeated, as the
// API reads it; language, the facets and the name filters are only
// repeated, because the API reads a comma in them literally. The sort is
// taken as written, since the API validates it.
export function testsQueryFromUrl(url: UrlQuery): TestsUrlQuery {
  const decoded = decodePageQuery(url, TESTS_PAGE_PARAMETER_DEFINITIONS);
  const sort = (decoded.sort ?? []).filter((term) => term !== "");
  const filters = noFacetValues();
  for (const facet of TESTS_FACETS) {
    filters[facet] = decoded[facet] ?? [];
  }
  const nameFilters = noNameFilterValues();
  for (const name of NAME_FILTERS) {
    nameFilters[name] = decoded[name] ?? [];
  }
  return {
    sort: sort.length === 0 ? DEFAULT_TESTS_SORT : sort.join(","),
    window:
      decoded.window === undefined || decoded.window === ""
        ? undefined
        : decoded.window,
    ranOn: decoded.ran_on ?? [],
    languages: decoded.language ?? [],
    filters,
    nameFilters,
    search: decoded.search ?? "",
  };
}

// The URL's query checked against the options: a value they do not offer is
// dropped, a choice left empty falls back to the API's default, and the rest
// is put in menu order. The name filters have no options to check against
// and are kept as written, once each.
export function resolveTestsQuery(
  url: TestsUrlQuery,
  options: TestOptions
): TestsQuery {
  const window = menuOrder(
    url.window === undefined ? [] : [url.window],
    options.window.values
  );
  const ranOn = menuOrder(url.ranOn, options.ran_on.values);
  const languages = menuOrder(url.languages, options.language.values);
  const filters = noFacetValues();
  for (const facet of TESTS_FACETS) {
    const choice = facetChoice(options, facet);
    const chosen = menuOrder(url.filters[facet], choice.values);
    filters[facet] = chosen.length > 0 ? chosen : [...choice.default];
  }
  const nameFilters = noNameFilterValues();
  for (const name of NAME_FILTERS) {
    nameFilters[name] = Array.from(new Set(url.nameFilters[name]));
  }
  return {
    sort: url.sort,
    window: window[0] ?? options.window.default,
    ranOn: ranOn.length > 0 ? ranOn : [...options.ran_on.default],
    languages: languages.length > 0 ? languages : [...options.language.default],
    filters,
    nameFilters,
    search: url.search,
  };
}

export type TestsUrlParams = Record<
  TestsPageParameterName,
  string | string[] | undefined
>;

// Whether two lists hold the same values in the same order. Compared value
// by value: joined into strings, one empty value, which the options offer as
// "none", would read as no value at all.
function sameValues(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

// The URL parameters for a query, each in the API's spelling by the page's
// parameter definitions (pageUrlParams: ran_on and sort comma-separated,
// language, the facets and the name filters repeated once per value), and
// undefined at the defaults so they are left off: the options' defaults for
// the choices they cover, the definitions' for the rest.
export function testsUrlParams(
  query: TestsQuery,
  options: TestOptions
): TestsUrlParams {
  const ranOn = menuOrder(query.ranOn, options.ran_on.values);
  const defaultRanOn = menuOrder(options.ran_on.default, options.ran_on.values);
  const languages = menuOrder(query.languages, options.language.values);
  const defaultLanguages = menuOrder(
    options.language.default,
    options.language.values
  );
  const values: PageQueryValues<typeof TESTS_PAGE_PARAMETER_DEFINITIONS> = {
    sort: query.sort.split(","),
    window: query.window === options.window.default ? undefined : query.window,
    ran_on: sameValues(ranOn, defaultRanOn) ? undefined : ranOn,
    language: sameValues(languages, defaultLanguages) ? undefined : languages,
    search: query.search,
  };
  for (const facet of TESTS_FACETS) {
    const choice = facetChoice(options, facet);
    const chosen = menuOrder(query.filters[facet], choice.values);
    const defaults = menuOrder(choice.default, choice.values);
    values[facet] = sameValues(chosen, defaults) ? undefined : chosen;
  }
  for (const name of NAME_FILTERS) {
    values[name] = query.nameFilters[name];
  }
  return pageUrlParams(values, TESTS_PAGE_PARAMETER_DEFINITIONS);
}

// One string per distinct query, for state that must restart when it changes.
export function testsQueryKey(query: TestsQuery): string {
  return [
    query.sort,
    query.window,
    [...query.ranOn].sort().join(","),
    [...query.languages].sort().join(","),
    query.search,
    ...TESTS_FACETS.map((facet) => [...query.filters[facet]].sort().join(",")),
    ...NAME_FILTERS.map((name) =>
      [...query.nameFilters[name]].sort().join(",")
    ),
  ].join("|");
}

// The header band's height: taller by however much the Name header's search
// field has grown past a key's height to hold its rows of name-filter chips
// (NameSearch measures that and reports it), so the field fits and the other
// headers' labels and keys stay centered.
export function columnHeaderHeightFor(searchFieldExtraHeight: number): number {
  return COLUMN_HEADER_HEIGHT + Math.max(0, searchFieldExtraHeight);
}

export type SortDirection = "asc" | "desc";

// The API sort parameter for the table's sort model: the column's fields,
// comma-separated, each prefixed with - when descending. undefined when the
// model is empty or names a column the table does not sort on.
export function sortParamOf(model: GridSortModel): string | undefined {
  const [item] = model;
  if (!item?.sort) {
    return undefined;
  }
  const fields = TESTS_TABLE_SORT_FIELDS[item.field];
  if (fields === undefined) {
    return undefined;
  }
  return fields
    .map((field) => (item.sort === "desc" ? `-${field}` : field))
    .join(",");
}

// The table's sort model for an API sort parameter: the column whose fields
// the parameter lists, in order and all in one direction. Empty when the
// parameter orders by anything else, which the table still sends to the API
// but has no header to show on.
export function sortModelOf(sortParam: string): GridSortModel {
  const terms = sortParam.split(",");
  const direction: SortDirection = terms[0].startsWith("-") ? "desc" : "asc";
  const descending = direction === "desc";
  if (!terms.every((term) => term.startsWith("-") === descending)) {
    return [];
  }
  const fields = terms.map((term) => term.replace(/^-/, ""));
  const column = Object.keys(TESTS_TABLE_SORT_FIELDS).find((name) => {
    const columnFields = TESTS_TABLE_SORT_FIELDS[name];
    return (
      columnFields.length === fields.length &&
      columnFields.every((field, index) => field === fields[index])
    );
  });
  return column === undefined ? [] : [{ field: column, sort: direction }];
}

export interface TestsApiRequest {
  // The repository as owner/name.
  repo: string;
  // What the page asks for.
  query: TestsQuery;
  // Entries per page.
  limit: number;
  // The cursor of the page to fetch; none for the first page.
  cursor?: string;
}

// The request for one page. It names the window, the code sources, any
// languages, any facet values and any name filters explicitly, as resolved
// from the options, so it asks for exactly what the title says, even if a
// deploy lands between the two requests.
export function testsApiUrl({
  repo,
  query,
  limit,
  cursor,
}: TestsApiRequest): string {
  const params = new URLSearchParams({
    repo,
    ran_on: query.ranOn.join(","),
    window: query.window,
    sort: query.sort,
    limit: String(limit),
  });
  for (const language of query.languages) {
    params.append("language", language);
  }
  for (const facet of TESTS_FACETS) {
    for (const value of query.filters[facet]) {
      params.append(facet, value);
    }
  }
  for (const name of NAME_FILTERS) {
    for (const value of query.nameFilters[name]) {
      params.append(name, value);
    }
  }
  if (query.search !== "") {
    params.set("search", query.search);
  }
  if (cursor !== undefined) {
    params.set("cursor", cursor);
  }
  return `/api/tests?${params.toString()}`;
}

// The API is behind the HUD GitHub gate. Which of its refusals a failed
// request met, if any: no accepted sign-in (401: none at all, or, for a
// reader who is signed in, one whose GitHub token has stopped working) or a
// GitHub account without write access to pytorch/pytorch (403). Undefined
// for every other failure. Both hooks keep the response status on the
// error.
export function accessReasonOf(
  error: unknown,
  signedIn: boolean
): "signed_out" | "expired" | "forbidden" | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 401) return signedIn ? "expired" : "signed_out";
  if (status === 403) return "forbidden";
  return undefined;
}

// What to tell the reader when a request to the API failed: the API's own
// error text when the response carried one (fetcherHandleError keeps it as
// info), else the error's message.
export function apiErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const { info, message } = error as { info?: unknown; message?: unknown };
    if (typeof info === "string" && info !== "") {
      return info;
    }
    if (typeof message === "string" && message !== "") {
      return message;
    }
  }
  return "unknown error";
}

// The page's numbers are set in English, like its sentences: digits grouped
// in threes with commas, "12,695", whatever the viewer's locale.
const integerFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

export function integerLabel(value: number): string {
  return integerFormat.format(value);
}

// A duration in the largest unit it fills, to three figures or so: "625 ms"
// under a second, then "12.7 s", "32.3 min" and "1.5 h". A value that would
// round up to the next unit, 59,950 ms say, is said in that unit, "1.0 min",
// never as "60.0 s".
export function durationLabel(milliseconds: number): string {
  if (milliseconds < 1000) {
    return `${integerLabel(milliseconds)} ms`;
  }
  const seconds = milliseconds / 1000;
  if (seconds < 59.95) {
    return `${seconds.toFixed(1)} s`;
  }
  const minutes = seconds / 60;
  if (minutes < 59.95) {
    return `${minutes.toFixed(1)} min`;
  }
  return `${(minutes / 60).toFixed(1)} h`;
}

// How many passed runs a mean duration is over, as the cell says it beneath
// the mean: "8 passed runs", "1 passed run", "0 passed runs".
export function passedRunsLabel(passedRuns: number): string {
  return `${integerLabel(passedRuns)} passed run${passedRuns === 1 ? "" : "s"}`;
}

// The footer's text for the rows on screen: "1–25", "26–50", "51–73". The
// API gives no total, and an exact count only ever arrives with the last
// page, so "of N" is never shown; an empty table shows nothing.
export function displayedRowsLabel({
  from,
  to,
  count,
}: {
  from: number;
  to: number;
  count: number;
}): string {
  return count === 0 ? "" : `${from}–${to}`;
}

export interface PageCountsInput {
  // The request for the page failed.
  failed: boolean;
  // The page shown is still on its way; any page already shown is stale.
  loading: boolean;
  // The page shown once it has arrived: its rows and whether another follows.
  page: { rows: number; hasNext: boolean } | undefined;
  // Zero-based index and size of the page shown.
  pageIndex: number;
  pageSize: number;
}

// What the grid's footer is told. The row count is exact once the last page
// has arrived, 0 after a failure, else -1 for unknown, which the footer
// shows as "of more than". hasNextPage is left undefined while nothing
// definite is known, so the grid keeps its buttons as they are.
export function pageCounts({
  failed,
  loading,
  page,
  pageIndex,
  pageSize,
}: PageCountsInput): { rowCount: number; hasNextPage: boolean | undefined } {
  if (failed) {
    return { rowCount: 0, hasNextPage: false };
  }
  if (loading || page === undefined) {
    return { rowCount: -1, hasNextPage: undefined };
  }
  return {
    rowCount: page.hasNext ? -1 : pageIndex * pageSize + page.rows,
    hasNextPage: page.hasNext,
  };
}
