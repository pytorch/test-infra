import { mayPassOnRetry, requestJson } from "lib/tests/request";
import { useState } from "react";
import useSWR, { SWRConfiguration } from "swr";

// One resource of the HUD API through SWR, as every hook in lib/tests/
// reads its own (useTestsOptions, useTestDetail, useTestGrid): nothing until
// the URL is known (null), the answer kept in SWR's cache per URL, and asked
// again on its own only after a failure that may pass on retry, three times,
// five seconds and more apart; a 4xx is the API's verdict on the request, a
// refusal of the sign-in among them, and would only repeat. The page's Retry
// button goes through retry(), which asks again and hides the error while
// the answer is on its way, since SWR keeps the error until then, so the
// page shows its loading state instead.
export function useApiResource<Answer>(
  url: string | null,
  config: SWRConfiguration<Answer> = {},
  fetcher: (_url: string) => Promise<Answer> = requestJson
): {
  // undefined until the endpoint answers, or after it fails (with
  // keepPreviousData, the answer shown last while a new URL loads).
  data: Answer | undefined;
  // The failure, from the first failed attempt on while SWR asks again in
  // the background; none while a retry asked for through retry() is on its
  // way.
  error: unknown;
  // No answer yet for this URL.
  isLoading: boolean;
  // A retry asked for through retry() is on its way.
  retrying: boolean;
  retry: () => Promise<void>;
} {
  const { data, error, mutate, isLoading } = useSWR<Answer>(url, fetcher, {
    revalidateOnFocus: false,
    errorRetryCount: 3,
    shouldRetryOnError: mayPassOnRetry,
    ...config,
  });
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    try {
      await mutate();
    } finally {
      setRetrying(false);
    }
  };
  return {
    data,
    error: retrying ? undefined : error,
    isLoading,
    retrying,
    retry,
  };
}
