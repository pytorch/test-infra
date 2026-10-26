import type { GridPaginationModel } from "@mui/x-data-grid";
import type { TestHealthEntry, TestListPage } from "lib/api/tests/types";
import {
  DEFAULT_TESTS_PAGE_SIZE,
  pageCounts,
  testsApiUrl,
  TestsQuery,
  testsQueryKey,
} from "lib/tests/table";
import { useEffect, useMemo, useRef, useState } from "react";

// Where the listing is in the API's cursor chain. Pages are reached one at a
// time, so the cursor that fetched each visited page is kept to return to it.
interface Paging {
  // The query the pages were walked under; another query restarts the walk.
  key: string;
  pageSize: number;
  // Zero-based, as the grid counts.
  page: number;
  // cursors[page] fetched that page; the first page has no cursor.
  cursors: (string | undefined)[];
}

function firstPage(key: string, pageSize: number): Paging {
  return { key, pageSize, page: 0, cursors: [undefined] };
}

// How long a page took to arrive, which the caption under the table says.
export interface PageTiming {
  // Milliseconds from asking the API for the page to its decoded response
  // arriving, the waits and attempts of a request asked again included.
  elapsedMs: number;
  // Of that, what the API spent on its database requests, as the page
  // reports in query_duration_ms.
  queryDurationMs: number;
}

// A page that arrived, with how long it took.
interface Fetched {
  page: TestListPage;
  timing: PageTiming;
}

// What the last request that was let finish came back with, under the URL
// it asked and the query key that URL belongs to.
interface Loaded {
  url: string;
  key: string;
  page?: TestListPage;
  // With the page: how long its request took.
  timing?: PageTiming;
  error?: unknown;
}

// One page of GET /api/tests and the means to turn its pages, for the
// heading and the table to share.
export interface TestsListing {
  // The entries of the page shown; none while the first page loads or after
  // a failure.
  entries: TestHealthEntry[];
  // When the health rows were last refreshed, read with the rows; a stale
  // page's while the next loads.
  refreshedAt: string | null;
  // How long the page shown took to arrive; null while there is no page
  // shown, so a page turn or a new query clears it until its page arrives.
  timing: PageTiming | null;
  error: unknown;
  // No page to show yet: the repository or the query is unknown, or the page
  // is on its way.
  loading: boolean;
  paginationModel: GridPaginationModel;
  onPaginationModelChange: (_model: GridPaginationModel) => void;
  // What the grid's footer is told; see pageCounts.
  rowCount: number;
  hasNextPage: boolean | undefined;
  // Asks again for the page whose failure is shown; does nothing otherwise.
  retry: () => void;
}

// How long a failed request waits before it is asked again, one wait per
// retry: two retries, three attempts in all. Few and short, since a page
// costs the database seconds and a failure that outlasts two quick re-asks
// is unlikely to pass on a third; the grid keeps its loading state meanwhile.
export const RETRY_DELAYS_MS = [1000, 3000];

// One attempt at a page from the API, or its error with the API's text as
// info, which apiErrorMessage reads. Aborting the signal rejects.
async function requestTestsPage(
  url: string,
  signal: AbortSignal
): Promise<TestListPage> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined);
    throw Object.assign(
      new Error("An error occurred while fetching the data"),
      {
        status: response.status,
        info: body?.error,
      }
    );
  }
  return response.json();
}

// Whether a failed attempt may pass if made again: the connection failed, so
// there is no status, or the server failed (5xx). A 4xx is the API's verdict
// on the request itself, a bad parameter or cursor, and would only repeat.
function mayPassOnRetry(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status !== "number" || status >= 500;
}

// Resolves after the given time, unless the signal aborts first: then it
// rejects at once with the signal's reason, as fetch does, so an abandoned
// request is not asked again.
function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// One page from the API, asked again after each failure that may pass on
// retry until the delays run out; the last error is thrown. Aborting the
// signal rejects; the caller drops that.
async function fetchTestsPage(
  url: string,
  signal: AbortSignal
): Promise<TestListPage> {
  for (let failures = 0; ; failures++) {
    try {
      return await requestTestsPage(url, signal);
    } catch (error) {
      if (
        signal.aborted ||
        failures >= RETRY_DELAYS_MS.length ||
        !mayPassOnRetry(error)
      ) {
        throw error;
      }
      await wait(RETRY_DELAYS_MS[failures], signal);
    }
  }
}

export function useTestsListing({
  repo,
  query,
  pending = false,
}: {
  // The repository as owner/name; undefined until the router knows it.
  repo: string | undefined;
  // What to ask for; undefined until the options it was resolved against
  // have arrived, when nothing is fetched.
  query: TestsQuery | undefined;
  // The query is about to change, a search is being typed: nothing is
  // fetched, whatever is on its way is stopped, and nothing is shown.
  pending?: boolean;
}): TestsListing {
  const key = query === undefined ? "" : testsQueryKey(query);
  const [paging, setPaging] = useState(() =>
    firstPage(key, DEFAULT_TESTS_PAGE_SIZE)
  );
  // A query change, from a header, a choice or the URL, restarts the walk
  // during the same render; an effect would first fetch the new query with
  // the old cursor.
  const current = paging.key === key ? paging : firstPage(key, paging.pageSize);
  const apiUrl =
    repo === undefined || query === undefined
      ? null
      : testsApiUrl({
          repo,
          query,
          limit: current.pageSize,
          cursor: current.cursors[current.page],
        });

  const [loaded, setLoaded] = useState<Loaded | undefined>();
  // Clicks on the error's Retry button; each runs the effect again for the
  // URL whose failure was shown, which is fetched anew, failures not being
  // kept.
  const [retryClicks, setRetryClicks] = useState(0);
  // The pages fetched under this page load, by URL, so a page returned to
  // is shown at once, with the time its request took.
  const pages = useRef(new Map<string, Fetched>());
  useEffect(() => {
    if (apiUrl === null || pending) {
      return;
    }
    const cached = pages.current.get(apiUrl);
    if (cached !== undefined) {
      setLoaded({ url: apiUrl, key, ...cached });
      return;
    }
    const controller = new AbortController();
    const askedAt = performance.now();
    fetchTestsPage(apiUrl, controller.signal).then(
      (page) => {
        if (!controller.signal.aborted) {
          const fetched: Fetched = {
            page,
            timing: {
              elapsedMs: Math.round(performance.now() - askedAt),
              queryDurationMs: page.query_duration_ms,
            },
          };
          pages.current.set(apiUrl, fetched);
          setLoaded({ url: apiUrl, key, ...fetched });
        }
      },
      (error) => {
        if (!controller.signal.aborted) {
          setLoaded({ url: apiUrl, key, error });
        }
      }
    );
    // Another page, another query or a keystroke: this request, or the wait
    // before it is asked again, is stopped and its answer, should it still
    // arrive, is dropped.
    return () => controller.abort();
  }, [apiUrl, key, pending, retryClicks]);

  // The page asked for, once it has arrived. Between pages of one query the
  // rows already shown stay, under the grid's progress bar; a new query, or
  // a search still being typed, shows the loading skeleton instead, since
  // the rows no longer answer it.
  const shown =
    !pending && loaded !== undefined && loaded.url === apiUrl
      ? loaded
      : undefined;
  const held =
    shown === undefined && !pending && loaded?.key === key ? loaded : undefined;
  const page = shown?.page ?? held?.page;
  const loading = apiUrl === null || shown === undefined;

  const paginationModel = useMemo(
    () => ({ page: current.page, pageSize: current.pageSize }),
    [current.page, current.pageSize]
  );
  // Both are props of the grid: left to itself it could not change a
  // controlled row count once the last page arrived.
  const { rowCount, hasNextPage } = pageCounts({
    failed: shown?.error !== undefined,
    loading: shown === undefined,
    page:
      shown?.page === undefined
        ? undefined
        : {
            rows: shown.page.tests.length,
            hasNext: shown.page.pagination.next !== null,
          },
    pageIndex: current.page,
    pageSize: current.pageSize,
  });

  const onPaginationModelChange = (model: GridPaginationModel) => {
    if (model.pageSize !== current.pageSize) {
      setPaging(firstPage(key, model.pageSize));
    } else if (loading) {
      // The footer is disabled while loading; a page's next cursor is only
      // known once that page has arrived.
      return;
    } else if (
      model.page === current.page + 1 &&
      shown?.page?.pagination.next
    ) {
      setPaging({
        ...current,
        page: model.page,
        cursors: [
          ...current.cursors.slice(0, model.page),
          shown.page.pagination.next.cursor,
        ],
      });
    } else if (model.page < current.page) {
      setPaging({ ...current, page: model.page });
    }
  };

  // The Retry button: the failure shown goes, the loading state takes its
  // place and the effect asks for the URL again.
  const retry = () => {
    if (shown?.error === undefined) {
      return;
    }
    setLoaded(undefined);
    setRetryClicks((clicks) => clicks + 1);
  };

  return {
    entries: shown?.error !== undefined ? [] : page?.tests ?? [],
    // The health data's refresh time does not depend on the query, so the
    // last page's stands while another query loads, and the heading keeps
    // its sentence whole.
    refreshedAt: (page ?? loaded?.page)?.refreshed_at ?? null,
    timing: shown?.timing ?? null,
    error: shown?.error,
    loading,
    paginationModel,
    onPaginationModelChange,
    rowCount,
    hasNextPage,
    retry,
  };
}
