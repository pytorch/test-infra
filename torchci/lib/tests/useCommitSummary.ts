import type { CommitSummary } from "lib/api/tests/commit/summary/types";
import { commitSummaryApiUrl } from "lib/tests/commitPage";
import { useApiResource } from "lib/tests/useApiResource";
import { isNotFound } from "lib/tests/useTestDetail";
import { useEffect, useState } from "react";

// A commit's summary from GET /api/tests/commit/{sha}/summary, read as the
// hooks read the API (useApiResource): fetched once per page load and shared
// through SWR's cache, nothing until the repository and the commit are
// known, asked again on its own only after a failure that may pass on
// retry. When it arrived is kept for the table's caption.
export function useCommitSummary(
  repo: string | undefined,
  sha: string | undefined
): {
  // undefined until the endpoint answers, or after it fails.
  summary: CommitSummary | undefined;
  // When the summary shown arrived, as an ISO timestamp; null before.
  fetchedAt: string | null;
  // HUD has no commit with this SHA in this repository.
  notFound: boolean;
  // Any other failure, the gate's refusals among them.
  error: unknown;
  retry: () => void;
} {
  const url =
    repo === undefined || sha === undefined
      ? null
      : commitSummaryApiUrl(repo, sha);
  const { data, error, retry } = useApiResource<CommitSummary>(url);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  useEffect(() => {
    setFetchedAt(data === undefined ? null : new Date().toISOString());
  }, [data]);
  const notFound = isNotFound(error);
  return {
    summary: data,
    fetchedAt,
    notFound,
    error: notFound ? undefined : error,
    retry,
  };
}
