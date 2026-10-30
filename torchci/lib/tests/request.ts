// One request to the HUD API, for the hooks in lib/tests/ to share: the JSON
// it answers, or an error that carries what the hooks and the page need to
// know about the failure.

// What a failed request's error carries besides its message: the response
// status, when the server answered, which accessReasonOf reads for the
// gate's refusals; the API's error text as info, which apiErrorMessage
// reads; and the API's error code, which a page may branch on, as the API
// asks, rather than on the text.
export interface RequestFailure extends Error {
  status?: number;
  info?: unknown;
  code?: unknown;
}

// One attempt at a URL of the API, as JSON. A response that is not ok throws
// a RequestFailure. Aborting the signal, when one is given, rejects as fetch
// does.
export async function requestJson<Answer>(
  url: string,
  init?: RequestInit
): Promise<Answer> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.json().catch(() => undefined);
    const failure: RequestFailure = Object.assign(
      new Error("An error occurred while fetching the data"),
      {
        status: response.status,
        info: body?.error,
        code: body?.code,
      }
    );
    throw failure;
  }
  return response.json();
}

// Whether a failed attempt may pass if made again: the connection failed, so
// there is no status, the server failed (5xx), or the database was full
// (429, the heavy queries' overloaded answer, which asks for a retry). Any
// other 4xx is the API's verdict on the request itself, a bad parameter, an
// unknown id, a stale cursor or a refusal of the sign-in, and would only
// repeat.
export function mayPassOnRetry(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status !== "number" || status >= 500 || status === 429;
}
