import type { TestSummary } from "lib/api/tests/summary/types";
import { testsSummaryApiUrl } from "lib/tests/figures";
import type { TestsQuery } from "lib/tests/table";
import { useApiResource } from "lib/tests/useApiResource";
import { useEffect, useRef } from "react";

// Whether the health refresh a summary was read at is older than the one
// the table shows, so the figures above the table are behind its rows.
export function figuresBehind(
  summaryRefreshedAt: string | null | undefined,
  tableRefreshedAt: string | null
): boolean {
  if (summaryRefreshedAt == null || tableRefreshedAt === null) {
    return false;
  }
  return Date.parse(summaryRefreshedAt) < Date.parse(tableRefreshedAt);
}

// The figures of the band above the tests table, from
// GET /api/tests/summary, read as the hooks read the API (useApiResource):
// nothing until the repository and the query are known, one request per
// window and choice of languages, kept in SWR's cache. The figures decorate
// the band and never hold it up: its cells work without them, so a failure
// here costs the reader the numbers and nothing else.
//
// The table is asked again whenever its query changes and the figures are
// not, so on a page left open the table can come to show a later health
// refresh than the figures were read at. When it does, the figures are
// asked for again, once for that refresh, so the count in a cell and the
// rows under it are of the same data.
export function useTestsSummary({
  repo,
  query,
  refreshedAt,
}: {
  // The repository as owner/name; undefined until the router knows it.
  repo: string | undefined;
  // The URL's query resolved against the options; undefined with them.
  query: Pick<TestsQuery, "window" | "languages"> | undefined;
  // The health refresh the table's rows were read at; null before a page.
  refreshedAt: string | null;
}): {
  // undefined until the endpoint answers, or after it fails.
  summary: TestSummary | undefined;
  // No answer yet: the figures' places are held.
  loading: boolean;
  // The failure, its automatic retries still running or spent.
  error: unknown;
  // Asks again after a failure.
  retry: () => void;
} {
  const url =
    repo === undefined || query === undefined
      ? null
      : testsSummaryApiUrl(repo, query);
  const { data, error, isLoading, retry } = useApiResource<TestSummary>(url);
  // The table's refresh the figures were last asked again for, so a summary
  // that stays behind, kept by the server for its minute, is not asked for
  // in a loop.
  const askedFor = useRef<string | null>(null);
  const behind = figuresBehind(data?.refreshed_at, refreshedAt);
  useEffect(() => {
    if (behind && askedFor.current !== refreshedAt) {
      askedFor.current = refreshedAt;
      void retry();
    }
    // retry is a new function on every render; the refresh is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [behind, refreshedAt]);
  return {
    summary: data,
    loading: url === null || isLoading,
    error,
    retry: () => void retry(),
  };
}
