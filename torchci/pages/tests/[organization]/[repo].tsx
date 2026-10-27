import { Stack } from "@mui/material";
import LoadError from "components/tests/LoadError";
import TestsHeading from "components/tests/TestsHeading";
import TestsTable, { TESTS_TABLE_WIDTH } from "components/tests/TestsTable";
import type { Token } from "lib/tests/environment";
import {
  facetChoice,
  FacetValues,
  labelOf,
  menuOrder,
  TestsFacet,
} from "lib/tests/facets";
import {
  DEFAULT_TESTS_SORT,
  resolveTestsQuery,
  TestsQuery,
  testsQueryFromUrl,
  testsUrlParams,
} from "lib/tests/table";
import { useTestsListing } from "lib/tests/useTestsListing";
import { useTestsOptions } from "lib/tests/useTestsOptions";
import { useRouter } from "next/router";
import { useEffect, useMemo, useRef, useState } from "react";

// The tests of one repository, from GET /api/tests. What the page asks for,
// the sort, the health window, the code sources, the languages, the
// column filters and the name search, travels in the URL's query parameters,
// spelled as the API spells them and left off at the API's defaults. The
// choices, their labels and those defaults come from GET /api/tests/options;
// the URL is resolved against them before the list is requested.
// How long typing in the search may pause before the URL, and so the list,
// follows it.
const SEARCH_PAUSE_MS = 250;
// The page column's padding on each side, in theme spacing units.
const PAGE_PADDING = 2;

export default function Page() {
  const router = useRouter();
  const organization = router.query.organization;
  const repo = router.query.repo;
  const repository =
    typeof organization === "string" && typeof repo === "string"
      ? `${organization}/${repo}`
      : undefined;
  const {
    options,
    error: optionsError,
    retry: retryOptions,
  } = useTestsOptions();
  const urlQuery = useMemo(
    () => testsQueryFromUrl(router.query),
    [router.query]
  );
  const query = useMemo(
    () =>
      options === undefined ? undefined : resolveTestsQuery(urlQuery, options),
    [urlQuery, options]
  );
  // Text typed into the Name header's search that the URL does not carry
  // yet. The URL follows after a pause in typing, so a keystroke does not
  // fetch a page, while the table drops its rows and its loads at once.
  const [typedSearch, setTypedSearch] = useState<string | undefined>();
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const search = typedSearch ?? urlQuery.search;
  const searchPending =
    typedSearch !== undefined && typedSearch !== urlQuery.search;
  useEffect(() => {
    if (typedSearch !== undefined && typedSearch === urlQuery.search) {
      setTypedSearch(undefined);
    }
  }, [typedSearch, urlQuery.search]);
  useEffect(() => () => clearTimeout(searchTimer.current), []);
  const listing = useTestsListing({
    repo: repository,
    query,
    pending: searchPending,
  });

  // Writes the given parameters into the URL, leaving off those that are
  // undefined and keeping every other parameter as it is. Typing replaces
  // the history entry rather than adding one per keystroke.
  const updateUrl = (
    params: Record<string, string | string[] | undefined>,
    replace = false
  ) => {
    if (repository === undefined) {
      return;
    }
    const next: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries({
      ...router.query,
      ...params,
    })) {
      if (value !== undefined) {
        next[name] = value;
      }
    }
    const location = { pathname: router.pathname, query: next };
    void (replace
      ? router.replace(location, undefined, { shallow: true })
      : router.push(location, undefined, { shallow: true }));
  };
  const handleSortChange = (sort: string) =>
    updateUrl({ sort: sort === DEFAULT_TESTS_SORT ? undefined : sort });
  const handleQueryChange = (next: TestsQuery) => {
    if (options !== undefined) {
      updateUrl(testsUrlParams(next, options));
    }
  };
  // A header's filter menu changed some facets; each is put in menu order.
  const handleFiltersChange = (next: Partial<FacetValues>) => {
    if (query === undefined || options === undefined) {
      return;
    }
    const filters = { ...query.filters };
    for (const [facet, values] of Object.entries(next)) {
      filters[facet as TestsFacet] = menuOrder(
        values ?? [],
        facetChoice(options, facet as TestsFacet).values
      );
    }
    handleQueryChange({ ...query, filters });
  };
  // A value clicked in a cell narrows each of its facets to that value and
  // leaves the other facets as they are.
  const handleFilter = (filters: Token["filters"]) => {
    if (query === undefined) {
      return;
    }
    const next = { ...query.filters };
    for (const [facet, value] of Object.entries(filters)) {
      next[facet as TestsFacet] = value === undefined ? [] : [value];
    }
    handleQueryChange({ ...query, filters: next });
  };
  const commitSearch = (text: string, replace: boolean) =>
    updateUrl({ search: text === "" ? undefined : text }, replace);
  // A keystroke: the table empties at once; the URL follows after the pause.
  const handleSearchInput = (text: string) => {
    setTypedSearch(text);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(
      () => commitSearch(text, true),
      SEARCH_PAUSE_MS
    );
  };
  // A file or suite clicked in a cell, or Enter in the field: search now.
  const handleSearch = (text: string) => {
    clearTimeout(searchTimer.current);
    setTypedSearch(text);
    commitSearch(text, false);
  };

  // One fixed-width column, centered, holds the title and the table, so the
  // table does not stretch with the window: as wide as the table with every
  // column at its width, so at full width the table is whole, not scrolled
  // sideways.
  return (
    <Stack
      spacing={3}
      sx={{
        p: PAGE_PADDING,
        maxWidth: (theme) =>
          `calc(${TESTS_TABLE_WIDTH}px + ${theme.spacing(2 * PAGE_PADDING)})`,
        mx: "auto",
      }}
    >
      <TestsHeading
        repo={repository}
        options={options}
        query={query}
        onQueryChange={handleQueryChange}
      />
      {optionsError !== undefined && (
        <LoadError
          what="the choices"
          error={optionsError}
          onRetry={retryOptions}
        />
      )}
      <TestsTable
        listing={listing}
        sort={urlQuery.sort}
        onSortChange={handleSortChange}
        options={options}
        windowLabel={
          query === undefined || options === undefined
            ? undefined
            : labelOf(query.window, options.window.values)
        }
        filters={query?.filters}
        onFiltersChange={handleFiltersChange}
        onFilter={handleFilter}
        search={search}
        onSearchInput={handleSearchInput}
        onSearch={handleSearch}
      />
    </Stack>
  );
}
