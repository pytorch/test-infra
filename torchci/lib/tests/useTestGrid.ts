import type { RunGrid } from "lib/api/tests/test/runs/types";
import { GridQuery, testGridApiUrl } from "lib/tests/grid";
import { requestJson } from "lib/tests/request";
import { useApiResource } from "lib/tests/useApiResource";
import type { PageTiming } from "lib/tests/useTestsListing";

// A grid that arrived, with how long it took, as the list keeps its pages.
interface Fetched {
  grid: RunGrid;
  timing: PageTiming;
}

async function fetchGrid(url: string): Promise<Fetched> {
  const askedAt = performance.now();
  const grid = await requestJson<RunGrid>(url);
  return {
    grid,
    timing: {
      elapsedMs: Math.round(performance.now() - askedAt),
      queryDurationMs: grid.query_duration_ms,
    },
  };
}

// The grid of one test's runs for the header's choices, from GET
// /api/tests/test/{test_id}/runs?group_by=commit, read as the hooks read the
// API (useApiResource): nothing until the id and the choices are known, kept
// in SWR's cache per URL so a choice returned to is shown at once, asked
// again on its own only after a failure that may pass on retry. While new
// choices load, the grid last shown stays, with `loading` saying a new one
// is on its way, so the table shows a progress bar over the old rows instead
// of emptying into a skeleton at every change of window.
export function useTestGrid(
  testId: string | undefined,
  query: GridQuery | undefined
): {
  // undefined until the endpoint first answers, or after it fails; while
  // new choices load, the grid shown last.
  grid: RunGrid | undefined;
  // How long the grid shown took to arrive; null while one is on its way
  // or after a failure.
  timing: PageTiming | null;
  // No answer yet for these choices.
  loading: boolean;
  // The failure, from the first failed attempt on while SWR asks again in
  // the background; none while a retry asked for through retry() is on its
  // way, so the grid shows its loading state instead.
  error: unknown;
  retry: () => void;
} {
  const url =
    testId === undefined || query === undefined
      ? null
      : testGridApiUrl(testId, query);
  const { data, error, isLoading, retrying, retry } = useApiResource<Fetched>(
    url,
    { keepPreviousData: true },
    fetchGrid
  );
  const loading = url === null || isLoading || retrying;
  return {
    grid: data?.grid,
    timing: loading || error !== undefined ? null : data?.timing ?? null,
    loading,
    error,
    retry,
  };
}
