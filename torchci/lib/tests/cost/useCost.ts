import type { RunnerHours } from "lib/api/tests/cost/types";
import { requestJson } from "lib/tests/request";
import { useApiResource } from "lib/tests/useApiResource";
import type { PageTiming } from "lib/tests/useTestsListing";

// An answer with how long it took to arrive, for the "Loaded in" caption:
// from asking to the decoded response, and of that what the API spent in the
// database (its query_duration_ms).
export type Timed<Answer> = Answer & { timing: PageTiming };

async function timedRequest<Answer extends { query_duration_ms: number }>(
  url: string
): Promise<Timed<Answer>> {
  const started = performance.now();
  const answer = await requestJson<Answer>(url);
  return {
    ...answer,
    timing: {
      elapsedMs: performance.now() - started,
      queryDurationMs: answer.query_duration_ms,
    },
  };
}

// The runner-hours for their URL (null until the page knows it), read as the hub's
// hooks read the API (useApiResource).
export function useRunnerHours(url: string | null) {
  const { data, error, isLoading, retry } = useApiResource<Timed<RunnerHours>>(
    url,
    { keepPreviousData: true },
    timedRequest
  );
  return { runnerHours: data, error, isLoading, retry };
}
