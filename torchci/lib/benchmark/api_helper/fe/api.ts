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
  if (!res.ok) {
    let message = `Request failed with ${res.status}`;
    try {
      const payload = await res.json();
      if (payload?.error) message = payload.error;
    } catch {
      // if not valid JSON, ignore
    }
    throw new Error(message);
  }
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
    let message = `Request failed with ${res.status}`;
    try {
      const payload = await res.json();
      if (payload?.error) message = payload.error;
    } catch {
      // if not valid JSON, ignore
    }
    throw new Error(message);
  }

  return res.json();
}

export async function postBenchmarkMetadataFetcher<T>(
  name: string,
  queryParams: Record<string, unknown>
): Promise<T> {
  const body = {
    name: name,
    query_params: queryParams,
  };
  const url = "/api/benchmark/list_metadata";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let message = `Request failed with ${res.status}`;
    try {
      const payload = await res.json();
      if (payload?.error) message = payload.error;
    } catch {
      // if not valid JSON, ignore
    }
    throw new Error(message);
  }
  return res.json();
}

export async function listBenchmarkRegressionReport<T>(
  report_id: string,
  limit: number = 10,
  last_ts_token?: string
): Promise<T> {
  const body = {
    report_id: report_id,
    limit: limit,
    last_ts_token: last_ts_token ?? undefined,
  };
  const url = "/api/benchmark/list_regression_summary_reports";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let message = `Request failed with ${res.status}`;
    try {
      const payload = await res.json();
      if (payload?.error) message = payload.error;
    } catch {
      // if not valid JSON, ignore
    }
    throw new Error(message);
  }

  return res.json();
}

export async function getBenchmarkRegressionReport<T>(id: string): Promise<T> {
  const body = {
    id,
  };
  const url = "/api/benchmark/get_regression_summary_report";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let message = `Request failed with ${res.status}`;
    try {
      const payload = await res.json();
      if (payload?.error) message = payload.error;
    } catch {
      // if not valid JSON, ignore
    }
    throw new Error(message);
  }
  return res.json();
}
