import type { TestOptions } from "lib/api/tests/options/types";
import { useApiResource } from "lib/tests/useApiResource";

export const TESTS_OPTIONS_URL = "/api/tests/options";

// The choices the title offers, from GET /api/tests/options: the values the
// list accepts, their labels and its defaults, read as the hooks read the
// API (useApiResource): fetched once per page load and shared through SWR's
// cache, the API letting it be cached briefly too, and asked again on its
// own only after a failure that may pass on retry.
export function useTestsOptions(): {
  // undefined until the endpoint answers, or after it fails.
  options: TestOptions | undefined;
  // The failure; none while a retry asked for through retry() is on its
  // way, so the page shows its loading state instead.
  error: unknown;
  // Asks again after a failure.
  retry: () => void;
} {
  const { data, error, retry } = useApiResource<TestOptions>(TESTS_OPTIONS_URL);
  return { options: data, error, retry };
}
