import type { CommitRunListPage } from "lib/api/tests/commit/types";
import type { RunRecord } from "lib/api/tests/test/runs/types";
import { mayPassOnRetry, requestJson } from "lib/tests/request";
import { useApiResource } from "lib/tests/useApiResource";
import type { PageTiming } from "lib/tests/useTestsListing";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// A first page that arrived, with how long it took, as the grid keeps its
// own (useTestGrid).
interface Fetched {
  page: CommitRunListPage;
  timing: PageTiming;
}

async function fetchFirstPage(url: string): Promise<Fetched> {
  const askedAt = performance.now();
  const page = await requestJson<CommitRunListPage>(url);
  return {
    page,
    timing: {
      elapsedMs: Math.round(performance.now() - askedAt),
      queryDurationMs: page.query_duration_ms,
    },
  };
}

// A first page asked for ahead of the hook that reads it, one at a time:
// the page asks at the click that changes what is listed, and the hook,
// which follows the URL a render later, takes the answer.
let early: { url: string; fetched: Promise<Fetched> } | null = null;

export function startRunsListing(url: string): void {
  if (early?.url === url) return;
  const fetched = fetchFirstPage(url);
  // A failure is the hook's to show.
  fetched.catch(() => undefined);
  early = { url, fetched };
}

function firstPage(url: string): Promise<Fetched> {
  if (early?.url !== url) return fetchFirstPage(url);
  const { fetched } = early;
  early = null;
  return fetched;
}

// A list of run bundles grown a page at a time: the first page from the
// given URL, read as the hooks read the API (useApiResource), and each
// "Show more" the page the API's next link names, appended. Another first
// URL, a new sort or filter, starts over. How long the first page took is
// kept for the caption under the table.
export interface RunsListing {
  // Every bundle loaded so far, in the API's order; none until the first
  // page arrives.
  runs: RunRecord[];
  // The first page is on its way.
  loading: boolean;
  // A further page is on its way.
  loadingMore: boolean;
  // Another page follows the loaded ones.
  hasMore: boolean;
  // The first page's failure, or a further page's.
  error: unknown;
  // How long the first page took; null before it arrives.
  timing: PageTiming | null;
  // Asks for the next page; nothing when there is none or one is on its way.
  loadMore: () => void;
  // Asks again after a failure.
  retry: () => void;
}

interface More {
  // The first URL the further pages belong to.
  url: string;
  runs: RunRecord[];
  next: string | null;
}

const NO_RUNS: RunRecord[] = [];

export function useRunsListing(url: string | null): RunsListing {
  const {
    data: fetched,
    error,
    isLoading,
    retry,
  } = useApiResource<Fetched>(url, {}, firstPage);
  const data = fetched?.page;
  const [more, setMore] = useState<More | null>(null);
  const [moreError, setMoreError] = useState<unknown>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  // The first URL in force, so a further page that arrives, or fails, after
  // the listing moved on to another first URL is dropped.
  const current = useRef(url);
  current.current = url;
  useEffect(() => {
    setMore(null);
    setMoreError(undefined);
    setLoadingMore(false);
  }, [url]);
  const extra = more !== null && more.url === url ? more : null;
  const next = extra !== null ? extra.next : data?.pagination.next?.url ?? null;
  const loadMore = useCallback(async () => {
    if (next === null || loadingMore || url === null) return;
    setLoadingMore(true);
    setMoreError(undefined);
    try {
      const page = await requestJson<CommitRunListPage>(next);
      if (current.current !== url) return;
      setMore((previous) => ({
        url,
        runs: [...(previous?.url === url ? previous.runs : []), ...page.runs],
        next: page.pagination.next?.url ?? null,
      }));
    } catch (failure) {
      if (current.current === url) setMoreError(failure);
    } finally {
      if (current.current === url) setLoadingMore(false);
    }
  }, [next, loadingMore, url]);
  // Stable while the next page and the state behind it are, so a caller's
  // effect can depend on it.
  const loadMoreNow = useCallback(() => {
    void loadMore();
  }, [loadMore]);
  // One array per change of the pages, so a render that changed nothing of
  // them, a search keystroke's, does not have the table rebuild its rows.
  const runs = useMemo(
    () =>
      data === undefined
        ? NO_RUNS
        : extra === null
        ? data.runs
        : [...data.runs, ...extra.runs],
    [data, extra]
  );
  return {
    runs,
    loading: url !== null && isLoading,
    loadingMore,
    hasMore: next !== null,
    error: error ?? moreError,
    timing: fetched?.timing ?? null,
    loadMore: loadMoreNow,
    // A further page's failure is asked again where it may pass, and
    // forgotten either way; any other failure starts the listing over.
    retry: () => {
      if (moreError !== undefined) {
        setMoreError(undefined);
        if (mayPassOnRetry(moreError)) {
          void loadMore();
          return;
        }
      }
      void retry();
    },
  };
}
