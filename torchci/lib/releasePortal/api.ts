import useSWR from "swr";

export interface ReleaseRequestError extends Error {
  status?: number;
  info?: unknown;
  code?: unknown;
}

export interface ReleaseResource<Answer> {
  data: Answer | undefined;
  error: unknown;
  isLoading: boolean;
  retry: () => Promise<void>;
}

export async function fetchRelease<Answer>(url: string): Promise<Answer> {
  const response = await fetch(url);
  if (response.ok) return response.json();

  const body = await response.json().catch(() => undefined);
  throw Object.assign(new Error("Could not load release data"), {
    status: response.status,
    info: body?.error,
    code: body?.code,
  } satisfies Partial<ReleaseRequestError>);
}

function mayRetry(error: unknown): boolean {
  const status = (error as ReleaseRequestError | null)?.status;
  return typeof status !== "number" || status >= 500 || status === 429;
}

export function useReleaseResource<Answer>(
  url: string | null
): ReleaseResource<Answer> {
  const { data, error, isLoading, mutate } = useSWR<Answer>(url, fetchRelease, {
    revalidateOnFocus: false,
    errorRetryCount: 3,
    shouldRetryOnError: mayRetry,
  });

  return {
    data,
    error,
    isLoading: url !== null && isLoading,
    retry: async () => {
      await mutate();
    },
  };
}

export function isReleaseNotFound(error: unknown): boolean {
  const failure = error as ReleaseRequestError | null;
  return failure?.status === 404 || failure?.code === "not_found";
}

export function releaseErrorMessage(error: unknown): string {
  const failure = error as ReleaseRequestError | null;
  return typeof failure?.info === "string"
    ? failure.info
    : "Please try again in a moment.";
}
