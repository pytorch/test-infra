export async function listBenchmarkCommits<T>(
  name: string,
  queryParams: Record<string, any>,
  response_formats: string[] = ["branch"]
): Promise<T> {
  const body = {
    name: name,
    query_params: queryParams,
    response_formats: response_formats,
  };
  const url = "/api/benchmark/list_commits";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function postBenchmarkTimeSeriesFetcher<T>(
  name: string,
  formats: string[],
  queryParams: Record<string, unknown>
): Promise<T> {
  const body = {
    name: name,
    query_params: queryParams,
    response_formats: formats,
  };
  const url = "/api/benchmark/get_time_series";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const payload = res.json();
    throw new Error(`Failed to fetch data" ${res.status} ,${payload}`);
  }
  return res.json();
}

export async function listBenchmarkRegressionReport<T>(
  report_id: string,
  limit: number = 10,
  response_formats: string[] = ["branch"]
): Promise<T> {
  const body = {
    report_id: report_id,
    limit: limit,
    response_formats: response_formats,
  };
  const url = "/api/benchmark/list_regression_summary_reports";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}
