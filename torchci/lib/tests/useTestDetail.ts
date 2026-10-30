import type { TestDetail } from "lib/api/tests/test/types";
import { useApiResource } from "lib/tests/useApiResource";

// Where GET /api/tests/test/{test_id} answers for the given test.
export function testDetailApiUrl(testId: string): string {
  return `/api/tests/test/${encodeURIComponent(testId)}`;
}

// The API's code for an id no test has, from its 404.
const NOT_FOUND_CODE = "not_found";

export function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === NOT_FOUND_CODE;
}

// One test with its owners and all its health, from
// GET /api/tests/test/{test_id}, read as the hooks read the API
// (useApiResource): fetched once per page load and shared through SWR's
// cache, nothing until the id is known, asked again on its own only after a
// failure that may pass on retry.
export function useTestDetail(testId: string | undefined): {
  // undefined until the endpoint answers, or after it fails.
  detail: TestDetail | undefined;
  // The API has no test with this id. Nothing is asked again: the answer
  // would be the same.
  notFound: boolean;
  // Any other failure, the gate's refusals among them; none while a retry
  // is on its way.
  error: unknown;
  // Asks again after a failure.
  retry: () => void;
} {
  const { data, error, retry } = useApiResource<TestDetail>(
    testId === undefined ? null : testDetailApiUrl(testId)
  );
  const notFound = isNotFound(error);
  return {
    detail: data,
    notFound,
    error: notFound ? undefined : error,
    retry,
  };
}
