import { CommitHeaderSummary, commitSummaryApiUrl } from "lib/tests/commitPage";
import { useApiResource } from "lib/tests/useApiResource";
import { isNotFound } from "lib/tests/useTestDetail";

// A commit's summary from GET /api/tests/commit/{sha}/summary, the fields
// the header shows (COMMIT_HEADER_FIELDS), read as the hooks read the API
// (useApiResource): fetched once per page load and shared through SWR's
// cache, nothing until the repository and the commit are known, asked again
// on its own only after a failure that may pass on retry.
export function useCommitSummary(
  repo: string | undefined,
  sha: string | undefined
): {
  // undefined until the endpoint answers, or after it fails.
  summary: CommitHeaderSummary | undefined;
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
  const { data, error, retry } = useApiResource<CommitHeaderSummary>(url);
  const notFound = isNotFound(error);
  return {
    summary: data,
    notFound,
    error: notFound ? undefined : error,
    retry,
  };
}
