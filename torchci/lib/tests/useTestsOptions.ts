import type { TestOptions } from "lib/api/tests/options/types";
import { fetcherHandleError } from "lib/GeneralUtils";
import { useState } from "react";
import useSWR from "swr";

export const TESTS_OPTIONS_URL = "/api/tests/options";

// The choices the title offers, from GET /api/tests/options: the values the
// list accepts, their labels and its defaults. Fetched once per page load and
// shared through SWR's cache; the API lets it be cached briefly too.
export function useTestsOptions(): {
  // undefined until the endpoint answers, or after it fails.
  options: TestOptions | undefined;
  // The failure, from the first failed attempt on while SWR asks again in
  // the background; none while a retry asked for through retry() is on its
  // way, so the page shows its loading state instead.
  error: unknown;
  // Asks again after a failure.
  retry: () => void;
} {
  const { data, error, mutate } = useSWR<TestOptions>(
    TESTS_OPTIONS_URL,
    fetcherHandleError,
    {
      revalidateOnFocus: false,
      // SWR asks again on its own this many times, five seconds and more
      // apart; after that only the Retry button asks. A 4xx is the API's
      // verdict on the request, a refusal of the sign-in among them, and
      // would only repeat.
      errorRetryCount: 3,
      shouldRetryOnError: (error) => {
        const status = (error as { status?: unknown })?.status;
        return typeof status !== "number" || status >= 500;
      },
    }
  );
  // SWR keeps the error until the request asked for has an answer.
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    try {
      await mutate();
    } finally {
      setRetrying(false);
    }
  };
  return { options: data, error: retrying ? undefined : error, retry };
}
