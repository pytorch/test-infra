import { Alert, Stack } from "@mui/material";
import AccessNotice from "components/tests/AccessNotice";
import CommitHeader from "components/tests/CommitHeader";
import CommitSummaryRow from "components/tests/CommitSummaryRow";
import CommitTable from "components/tests/CommitTable";
import LoadError from "components/tests/LoadError";
import PageColumn from "components/tests/PageColumn";
import { BUNDLE_STATUSES, BundleStatus } from "lib/tests/bundle";
import { shortSha } from "lib/tests/commit";
import {
  autoLoads,
  COMMIT_FACETS,
  CommitPageState,
  commitPageStateFromUrl,
  commitRunsApiUrl,
  commitUrlParams,
  PAGE_SIZE,
} from "lib/tests/commitPage";
import type { Token } from "lib/tests/environment";
import {
  facetChoice,
  FacetValues,
  menuOrder,
  TestsFacet,
} from "lib/tests/facets";
import { accessReasonOf, SEARCH_PAUSE_MS } from "lib/tests/table";
import { mergedUrlQuery } from "lib/tests/url";
import { useCommitSummary } from "lib/tests/useCommitSummary";
import { useRunsListing } from "lib/tests/useRunsListing";
import { useTestsOptions } from "lib/tests/useTestsOptions";
import { useSession } from "next-auth/react";
import { useRouter } from "next/router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// One commit of one repository: its header and summary row from GET
// /api/tests/commit/{sha}/summary, and under them its runs from GET
// /api/tests/commit/{sha}, one list in outcome order. What the table shows
// travels in the URL's query parameters, left off at the page's defaults
// (lib/api/tests/pages/parameters.ts, read and written in
// lib/tests/commitPage.ts): the search, the column filters, the outcomes
// listed and the sort; changes replace the entry in place. The runs come a
// page at a time: the pages are asked for one after another while the list
// is in the outcomes it loads whole (autoLoads), then on request. The API
// is behind the HUD GitHub gate, which the browser passes with its HUD
// sign-in cookie; when the API refuses, the page says why in place of the
// commit and offers the sign-in, as the other hub pages do. The summary and
// the runs are separate requests: when the summary fails, its error shows
// above the table and the runs are listed all the same.

export default function Page() {
  const router = useRouter();
  const { organization, repo, sha: shaParam } = router.query;
  const repository =
    typeof organization === "string" && typeof repo === "string"
      ? `${organization}/${repo}`
      : undefined;
  const sha = typeof shaParam === "string" ? shaParam.toLowerCase() : undefined;
  const session = useSession();
  const signedIn = session.status === "authenticated";
  const state = useMemo(
    () => commitPageStateFromUrl(router.query),
    [router.query]
  );
  const { summary, fetchedAt, notFound, error, retry } = useCommitSummary(
    repository,
    sha
  );
  const {
    options,
    error: optionsError,
    retry: retryOptions,
  } = useTestsOptions();
  // A commit older than the runs table keeps has no runs to show, and
  // neither has one whose jobs have not reported yet.
  const expired =
    summary !== undefined &&
    summary.counts.total.tests === 0 &&
    Date.parse(summary.commit.committed_at) <
      Date.parse(summary.retention_starts_at);
  const noRuns =
    summary !== undefined && summary.counts.total.tests === 0 && !expired;

  // The runs, asked for alongside the summary.
  const ready = repository !== undefined && sha !== undefined && !notFound;
  const listing = useRunsListing(
    ready ? commitRunsApiUrl(repository, sha, state, PAGE_SIZE) : null
  );
  const {
    runs,
    hasMore,
    loading: runsLoading,
    loadingMore,
    error: runsError,
    loadMore,
  } = listing;
  // The pages after the first are asked for one after another, under the
  // table's progress bar, while the list is in the outcomes loaded whole;
  // past that the table's "Show more" asks.
  useEffect(() => {
    if (
      !runsLoading &&
      !loadingMore &&
      runsError === undefined &&
      autoLoads(runs, hasMore)
    ) {
      loadMore();
    }
  }, [runs, hasMore, runsLoading, loadingMore, runsError, loadMore]);

  const accessReason =
    accessReasonOf(error, signedIn) ??
    accessReasonOf(optionsError, signedIn) ??
    accessReasonOf(runsError, signedIn);

  // A change of view: into the URL, in place of the current entry, with
  // every other parameter kept and the defaults left off. The state and the
  // router are read when the change is made, not when the handler was
  // created, so a change made after a pause, the search's, keeps what
  // changed in between.
  const latest = useRef({ state, router });
  latest.current = { state, router };
  const updateState = useCallback((change: Partial<CommitPageState>) => {
    const { state: current, router: currentRouter } = latest.current;
    void currentRouter.replace(
      {
        pathname: currentRouter.pathname,
        query: mergedUrlQuery(
          currentRouter.query,
          commitUrlParams({ ...current, ...change })
        ),
      },
      undefined,
      { shallow: true }
    );
  }, []);
  const handleSortChange = useCallback(
    (sort: string) => updateState({ sort }),
    [updateState]
  );
  // The outcomes listed, in the hub's order whatever order they were chosen.
  const handleStatusesChange = useCallback(
    (statuses: readonly BundleStatus[]) =>
      updateState({
        statuses: BUNDLE_STATUSES.filter((status) => statuses.includes(status)),
      }),
    [updateState]
  );
  // A status clicked in the summary: the table lists that outcome alone.
  const handleSelectStatus = useCallback(
    (status: BundleStatus) => handleStatusesChange([status]),
    [handleStatusesChange]
  );
  // A header's filter menu changed some facets; each is put in menu order.
  const handleFiltersChange = useCallback(
    (next: Partial<FacetValues>) => {
      if (options === undefined) return;
      const filters = { ...latest.current.state.filters };
      for (const [facet, values] of Object.entries(next)) {
        filters[facet as TestsFacet] = menuOrder(
          values ?? [],
          facetChoice(options, facet as TestsFacet).values
        );
      }
      updateState({ filters });
    },
    [options, updateState]
  );
  // A value clicked in a cell narrows each of its facets to that value.
  const handleFilter = useCallback(
    (filters: Token["filters"]) => {
      const next = { ...latest.current.state.filters };
      for (const [facet, value] of Object.entries(filters)) {
        if (!(COMMIT_FACETS as readonly string[]).includes(facet)) continue;
        next[facet as TestsFacet] = value === undefined ? [] : [value];
      }
      updateState({ filters: next });
    },
    [updateState]
  );
  // The search: what is typed shows at once; the URL, and so the API,
  // follow after a pause (SEARCH_PAUSE_MS), or at once for a click or Enter.
  const [typedSearch, setTypedSearch] = useState<string>();
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  useEffect(() => () => clearTimeout(searchTimer.current), []);
  useEffect(() => {
    setTypedSearch(undefined);
  }, [state.search]);
  const handleSearchInput = useCallback(
    (text: string) => {
      setTypedSearch(text);
      clearTimeout(searchTimer.current);
      searchTimer.current = setTimeout(
        () => updateState({ search: text }),
        SEARCH_PAUSE_MS
      );
    },
    [updateState]
  );
  const handleSearch = useCallback(
    (text: string) => {
      clearTimeout(searchTimer.current);
      setTypedSearch(text);
      updateState({ search: text });
    },
    [updateState]
  );

  if (accessReason !== undefined) {
    return (
      <PageColumn>
        <CommitHeader repo={repository ?? ""} commit={undefined} />
        <AccessNotice reason={accessReason} />
      </PageColumn>
    );
  }
  const loading = ready && summary === undefined && error === undefined;
  return (
    <PageColumn>
      <Stack spacing={2.5}>
        <CommitHeader
          repo={repository ?? ""}
          commit={summary?.commit}
          loading={loading}
        />
        {notFound && (
          <Alert severity="warning">
            HUD has no commit {sha === undefined ? "" : shortSha(sha)} in{" "}
            {repository}: GitHub reported no workflow run and no push for it.
          </Alert>
        )}
        {error !== undefined && (
          <LoadError what="the commit" error={error} onRetry={retry} />
        )}
        {optionsError !== undefined && (
          <LoadError
            what="the choices"
            error={optionsError}
            onRetry={retryOptions}
          />
        )}
        {expired && (
          <Alert severity="info">
            The runs of this commit are older than HUD keeps: the runs table
            holds the last 14 days.
          </Alert>
        )}
        {noRuns && (
          <Alert severity="info">
            No test runs are recorded for this commit yet.
          </Alert>
        )}
        {!notFound && error === undefined && !expired && !noRuns && (
          <CommitSummaryRow
            summary={summary}
            loading={loading}
            onSelectStatus={handleSelectStatus}
          />
        )}
        {!notFound && !expired && !noRuns && (
          <CommitTable
            // Another commit's table starts afresh: nothing expanded.
            key={sha}
            repo={repository ?? ""}
            runs={runs}
            loading={runsLoading}
            loadingMore={loadingMore}
            hasMore={hasMore}
            onLoadMore={loadMore}
            statuses={state.statuses}
            onStatusesChange={handleStatusesChange}
            error={runsError}
            onRetry={listing.retry}
            timing={listing.timing}
            refreshedAt={fetchedAt}
            sort={state.sort}
            onSortChange={handleSortChange}
            options={options}
            filters={state.filters}
            onFiltersChange={handleFiltersChange}
            onFilter={handleFilter}
            search={typedSearch ?? state.search}
            onSearchInput={handleSearchInput}
            onSearch={handleSearch}
          />
        )}
      </Stack>
    </PageColumn>
  );
}
