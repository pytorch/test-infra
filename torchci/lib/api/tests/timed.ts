// A query's result and how long it took, rounded to the millisecond, for
// the query_duration_ms an endpoint sums over its requests.
export function timed<Result>(
  work: Promise<Result>
): Promise<{ result: Result; duration_ms: number }> {
  const started = performance.now();
  return work.then((result) => ({
    result,
    duration_ms: Math.round(performance.now() - started),
  }));
}
