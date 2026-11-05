import type { PullRequestHead } from "lib/api/tests/pull/types";
import { pullRequestApiUrl } from "lib/tests/pullPage";
import { useApiResource } from "lib/tests/useApiResource";
import { isNotFound } from "lib/tests/useTestDetail";

// A pull request's newest head from GET /api/tests/pull/{number}, read as
// the hooks read the API (useApiResource): nothing until the repository and
// the number are known, asked again on its own only after a failure that
// may pass on retry.
export function usePullRequestHead(
  repo: string | undefined,
  number: string | undefined
): {
  // undefined until the endpoint answers, or after it fails.
  pullRequest: PullRequestHead | undefined;
  // HUD has no pull request with this number in this repository.
  notFound: boolean;
  // Any other failure, the gate's refusals among them.
  error: unknown;
  retry: () => void;
} {
  const url =
    repo === undefined || number === undefined
      ? null
      : pullRequestApiUrl(repo, number);
  const { data, error, retry } = useApiResource<PullRequestHead>(url);
  const notFound = isNotFound(error);
  return {
    pullRequest: data,
    notFound,
    error: notFound ? undefined : error,
    retry,
  };
}
