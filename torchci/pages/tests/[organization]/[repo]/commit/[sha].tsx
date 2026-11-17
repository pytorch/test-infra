import { Alert, Stack } from "@mui/material";
import CommitHeader from "components/tests/CommitHeader";
import CommitTable from "components/tests/CommitTable";
import CommitTestsTitle, { Glide } from "components/tests/CommitTestsTitle";
import CommitTimeline from "components/tests/CommitTimeline";
import LoadError from "components/tests/LoadError";
import PageColumn from "components/tests/PageColumn";
import { BUNDLE_STATUSES, BundleStatus } from "lib/tests/bundle";
import { shortSha } from "lib/tests/commit";
import {
  autoLoads,
  COMMIT_FACETS,
  CommitPageState,
  commitPageStateFromUrl,
  commitUrlParams,
  listedRunsApiUrl,
  pickFilteredOut,
  pickFilterOf,
  sameView,
  testCountsOf,
  usualStatuses,
} from "lib/tests/commitPage";
import type { Token } from "lib/tests/environment";
import {
  facetChoice,
  FacetValues,
  menuOrder,
  TestsFacet,
} from "lib/tests/facets";
import { SEARCH_PAUSE_MS } from "lib/tests/table";
import {
  commitCounts,
  countsTotal,
  jobFilterOf,
  noTestsWords,
  pickAbove,
  pickKey,
  TimelinePick,
} from "lib/tests/timeline";
import { mergedUrlQuery } from "lib/tests/url";
import { useCommitGreenlight } from "lib/tests/useCommitGreenlight";
import {
  useCommitTimeline,
  useFileTests,
  useJobDetail,
} from "lib/tests/useCommitJobs";
import { useCommitSummary } from "lib/tests/useCommitSummary";
import { startRunsListing, useRunsListing } from "lib/tests/useRunsListing";
import { useTestsOptions } from "lib/tests/useTestsOptions";
import { useRouter } from "next/router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// One commit of one repository: its header from GET
// /api/tests/commit/{sha}/summary; a timeline of its jobs from GET
// /api/tests/commit/{sha}/jobs (CommitTimeline); and under it its runs from
// GET /api/tests/commit/{sha}, one list in outcome order, under a title that
// sums them up (CommitTestsTitle). A row picked in the timeline, a workflow,
// a build, a job, a test file or a test, narrows the table and its title to
// it. What the page shows travels in the URL's query parameters, left off at
// the page's defaults (lib/api/tests/pages/parameters.ts, read and written
// in lib/tests/commitPage.ts): the pick, the search, the column filters, the
// outcomes listed and the sort; changes replace the entry in place. The
// runs come a page at a time: the pages are asked for one after another
// while the list is in the outcomes it loads whole (autoLoads), then on
// request. The page is public, as the other hub pages are: the API's GitHub
// gate lets its requests through. The summary, the jobs and the runs are
// separate requests: when one fails, its error shows in its place and the
// others are shown all the same.

export default function Page() {
  const router = useRouter();
  const { organization, repo, sha: shaParam } = router.query;
  const repository =
    typeof organization === "string" && typeof repo === "string"
      ? `${organization}/${repo}`
      : undefined;
  const sha = typeof shaParam === "string" ? shaParam.toLowerCase() : undefined;
  const state = useMemo(
    () => commitPageStateFromUrl(router.query),
    [router.query]
  );
  // A change made here is on its way to the URL until the URL says the
  // same. The timeline and the title show it at once, the pick above all;
  // the table follows the URL. A later change is made to it, not to the
  // URL it has yet to reach.
  const [written, setWritten] = useState<CommitPageState | null>(null);
  const writtenNow = useRef<CommitPageState | null>(null);
  useEffect(() => {
    if (writtenNow.current !== null && sameView(writtenNow.current, state)) {
      writtenNow.current = null;
      setWritten(null);
    }
  }, [state]);
  const view = written ?? state;
  // Each pick is one object for as long as it names the same pick, so what
  // follows it does not start over when another parameter changes.
  const listed = pickKey(state.pick);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const listedPick = useMemo(() => state.pick, [listed]);
  const picked = pickKey(view.pick);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pick = useMemo(() => view.pick, [picked]);
  const { summary, notFound, error, retry } = useCommitSummary(repository, sha);
  // GreenLight's verdict on the commit, asked for alongside the summary so
  // its pill is in the header when the header arrives.
  const greenlight = useCommitGreenlight(repository, sha);
  const {
    options,
    error: optionsError,
    retry: retryOptions,
  } = useTestsOptions();

  // The jobs and the runs, asked for alongside the summary. The runs are
  // those of the pick; a workflow or a build waits for the jobs, which say
  // what it holds.
  const ready = repository !== undefined && sha !== undefined && !notFound;
  const {
    timeline,
    error: timelineError,
    retry: retryTimeline,
  } = useCommitTimeline(ready ? repository : undefined, sha);
  // A commit older than the runs table keeps has no runs to show, and
  // neither has one whose jobs have not reported yet. The jobs' tests say
  // whether any test ran, the summary when the commit was made.
  const untested =
    summary !== undefined &&
    timeline !== undefined &&
    !timeline.testsPending &&
    countsTotal(commitCounts(timeline)) === 0;
  const old =
    summary !== undefined &&
    Date.parse(summary.commit.committed_at) <
      Date.parse(summary.retention_starts_at);
  const expired = untested && old;
  const noRuns = untested && !expired;
  // The jobs are drawn while their tests are read, but for a commit that may
  // turn out expired, which has no timeline: one made before the runs table
  // keeps, or one the summary has not yet said when it was made.
  const drawn =
    timeline?.testsPending &&
    timelineError === undefined &&
    (summary === undefined || old)
      ? undefined
      : timeline;
  const pickFilter = useMemo(
    () => pickFilterOf(listedPick, timeline),
    [listedPick, timeline]
  );
  const filteredOut =
    typeof pickFilter === "object" &&
    pickFilteredOut(state.filters, pickFilter);
  const runsUrl = ready
    ? listedRunsApiUrl(repository, sha, state, timeline)
    : null;
  const listing = useRunsListing(runsUrl);
  const {
    runs,
    hasMore,
    loading: runsLoading,
    loadingMore,
    error: runsError,
    loadMore,
  } = listing;
  // Why a list is empty waits for the jobs' tests, which say whether the
  // commit, a workflow, a build or a job recorded any: the table holds its
  // place until they do, or have failed to.
  const emptyUnexplained =
    runs.length === 0 &&
    (timeline === undefined || timeline.testsPending) &&
    timelineError === undefined &&
    pick?.kind !== "file" &&
    pick?.kind !== "test";
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

  // A change of view: into the URL, in place of the current entry, with
  // every other parameter kept and the defaults left off. The view and the
  // router are read when the change is made, not when the handler was
  // created, so a change made after a pause, the search's, keeps what
  // changed in between.
  const latest = useRef({ state, router, timeline, repository, sha, runsUrl });
  latest.current = { state, router, timeline, repository, sha, runsUrl };
  const viewNow = () => writtenNow.current ?? latest.current.state;
  const updateState = useCallback((change: Partial<CommitPageState>) => {
    const next = { ...viewNow(), ...change };
    writtenNow.current = next;
    setWritten(next);
    const { router: currentRouter, ...current } = latest.current;
    // The runs it lists are asked for now: the table, which follows the
    // URL, would ask a render later.
    if (current.repository !== undefined && current.sha !== undefined) {
      const nextUrl = listedRunsApiUrl(
        current.repository,
        current.sha,
        next,
        current.timeline
      );
      if (nextUrl !== null && nextUrl !== current.runsUrl) {
        startRunsListing(nextUrl);
      }
    }
    void currentRouter.replace(
      {
        pathname: currentRouter.pathname,
        query: mergedUrlQuery(currentRouter.query, commitUrlParams(next)),
      },
      undefined,
      { shallow: true }
    );
  }, []);
  // A row picked in the timeline, or a level of the title: the table lists
  // the outcomes usual for it. A name clicked in the timeline travels from
  // where it stood to the title.
  const glide = useRef<Glide | null>(null);
  const handlePick = useCallback(
    (next: TimelinePick | null, from?: DOMRect) => {
      glide.current =
        next === null || from === undefined
          ? null
          : { from, pick: pickKey(next) };
      updateState({ pick: next, statuses: usualStatuses(next) });
    },
    [updateState]
  );
  // The table's Job header is a second way to the same pick: what it shows
  // is the pick the table lists, and a job chosen in it is picked as a click
  // on its row is. The timeline does not scroll to a pick made there, where
  // the reader is in the table.
  const jobFilter = useMemo(
    () => jobFilterOf(timeline, listedPick),
    [timeline, listedPick]
  );
  const pickedInTable = useRef<string | null>(null);
  const handleJobFilter = useCallback(
    (jobId: string | null) => {
      const next: TimelinePick | null =
        jobId === null ? null : { kind: "job", jobId };
      pickedInTable.current = pickKey(next);
      handlePick(next);
    },
    [handlePick]
  );
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
  // A status clicked in the title: the table lists that outcome alone, and
  // on a second click the usual ones again.
  const solo = view.statuses.length === 1 ? view.statuses[0] : null;
  const handleSelectStatus = useCallback(
    (status: BundleStatus) => {
      const { statuses, pick: current } = viewNow();
      updateState({
        statuses:
          statuses.length === 1 && statuses[0] === status
            ? usualStatuses(current)
            : [status],
      });
    },
    [updateState]
  );
  // Esc steps back: from one outcome alone to the usual ones, else from the
  // pick to what holds it.
  useEffect(() => {
    const stepBack = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        (event.target as Element | null)?.closest?.("input, textarea")
      ) {
        return;
      }
      const { statuses, pick: current } = viewNow();
      if (statuses.length === 1) {
        updateState({ statuses: usualStatuses(current) });
      } else if (current !== null) {
        handlePick(pickAbove(latest.current.timeline, current));
      }
    };
    window.addEventListener("keydown", stepBack);
    return () => window.removeEventListener("keydown", stepBack);
  }, [updateState, handlePick]);
  // A header's filter menu changed some facets; each is put in menu order.
  const handleFiltersChange = useCallback(
    (next: Partial<FacetValues>) => {
      if (options === undefined) return;
      const filters = { ...viewNow().filters };
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
      const next = { ...viewNow().filters };
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

  // What the title sums up: the pick's tests by status. A file's are its
  // job's to say and a test's are its own runs, both read by the timeline
  // too; a test the timeline does not name is summed from the table. Each
  // is asked for when the timeline asks, a job's when the job is picked and
  // a file's tests when the file is, so one request answers both: asked for
  // a step later, the same URL was fetched a second time.
  const inJob =
    pick !== null && pick.kind !== "workflow" && pick.kind !== "build";
  const inFile = pick?.kind === "file" || pick?.kind === "test";
  const { data: jobDetail, error: pickedJobError } = useJobDetail(
    inJob ? pick.jobId : null
  );
  const pickedJob = pick?.kind === "file" ? jobDetail : undefined;
  const { data: listedTests } = useFileTests(
    repository ?? "",
    sha ?? "",
    inFile ? pick.jobId : null,
    inFile ? pick.file : null
  );
  const fileTests = pick?.kind === "test" ? listedTests : undefined;
  const loading = ready && summary === undefined && error === undefined;
  const testCounts = useMemo(() => {
    const named =
      pick?.kind !== "test"
        ? undefined
        : fileTests?.runs.filter(
            ({ test }) =>
              test?.case_name === pick.caseName &&
              (test.suite ?? "") === pick.suite
          );
    return testCountsOf({
      pick,
      timeline,
      job: pickedJob,
      runs:
        named !== undefined && named.length > 0
          ? named
          : runsLoading || picked !== listed
          ? undefined
          : runs,
    });
  }, [pick, picked, listed, timeline, pickedJob, fileTests, runs, runsLoading]);
  const [timelineBox, setTimelineBox] = useState<HTMLElement | null>(null);
  return (
    <PageColumn>
      <Stack spacing={2.5}>
        <CommitHeader
          repo={repository ?? ""}
          commit={summary?.commit}
          loading={loading}
          greenlight={greenlight}
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
        {!notFound && !expired && (
          <CommitTimeline
            // Another commit's timeline starts afresh: nothing unfolded.
            key={sha}
            ref={setTimelineBox}
            repo={repository ?? ""}
            sha={sha ?? ""}
            timeline={drawn}
            error={timelineError}
            onRetry={retryTimeline}
            pick={pick}
            onPick={handlePick}
            pickedInTable={pickedInTable}
          />
        )}
        {/* Where the tests would be listed, so that the timeline, drawn
            before the jobs' tests said so, stays where it is. */}
        {noRuns && (
          <Alert severity="info">
            No test runs are recorded for this commit yet.
          </Alert>
        )}
        {!notFound && !expired && !noRuns && (
          <CommitTestsTitle
            timeline={timeline}
            pick={pick}
            onPick={handlePick}
            counts={testCounts}
            // On its way until what it is read from has failed.
            loading={
              pick?.kind === "file"
                ? pickedJobError === undefined
                : pick?.kind === "test" || timelineError === undefined
            }
            solo={solo}
            onSelectStatus={handleSelectStatus}
            timelineBox={timelineBox}
            glide={glide}
          >
            {(top) => (
              <CommitTable
                // Another commit's table starts afresh: nothing expanded.
                key={sha}
                repo={repository ?? ""}
                runs={runs}
                loading={
                  runsLoading || pickFilter === "waiting" || emptyUnexplained
                }
                loadingMore={loadingMore}
                hasMore={hasMore}
                onLoadMore={loadMore}
                statuses={state.statuses}
                onStatusesChange={handleStatusesChange}
                error={runsError}
                onRetry={listing.retry}
                timing={listing.timing}
                top={top}
                emptyText={
                  filteredOut
                    ? "The workflow filter leaves this workflow out."
                    : pickFilter === "nothing"
                    ? "This commit has no such jobs."
                    : (timeline !== undefined &&
                        noTestsWords(timeline, listedPick)) ||
                      "No runs with the outcomes listed"
                }
                sort={state.sort}
                onSortChange={handleSortChange}
                options={options}
                filters={state.filters}
                onFiltersChange={handleFiltersChange}
                onFilter={handleFilter}
                search={typedSearch ?? state.search}
                onSearchInput={handleSearchInput}
                onSearch={handleSearch}
                jobFilter={jobFilter}
                onJobFilter={handleJobFilter}
              />
            )}
          </CommitTestsTitle>
        )}
      </Stack>
    </PageColumn>
  );
}
