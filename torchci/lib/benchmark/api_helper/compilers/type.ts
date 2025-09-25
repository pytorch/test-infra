import useSWR, { SWRResponse } from "swr";

export enum CompilerQueryType {
  PRECOMPUTE = "precompute",
  GENERAL = "general",
}

export const defaultGetTimeSeriesInputs: any = {
  models: [],
  commits: [],
  compilers: [],
  branches: [],
  device: "",
  arch: "",
  dtype: "",
  mode: "",
  granularity: "hour",
  startTime: "",
  stopTime: "",
  suites: [],
};

export const defaultListCommitsInputs: any = {
  branches: [],
  device: "",
  arch: [],
  dtype: "",
  mode: "",
  startTime: "",
  stopTime: "",
  suites: [],
};

export function getExtremeTs(
  rawData: Array<{ granularity_bucket: string | number | Date }>,
  mode: "min" | "max"
): number | null {
  if (!rawData?.length) return null;

  let extreme = mode === "min" ? Infinity : -Infinity;

  for (const row of rawData) {
    const ts = new Date(row.granularity_bucket as any).getTime();
    if (!Number.isFinite(ts)) continue;

    if (mode === "min") {
      if (ts < extreme) extreme = ts;
    } else {
      if (ts > extreme) extreme = ts;
    }
  }

  return Number.isFinite(extreme) ? extreme : null;
}

// --- Fetcher ---
export interface CompilerPrecomputeRequest {
  name: "compiler_precompute";
  query_params: Record<string, any>;
}

// generic response type
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

// --- Fetcher ---

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

export interface CompilerBundleResult {
  data: {
    data: any;
    time_range: any;
    total_raw_rows: number;
  };
}

// --- Hook wrapper ---
export function useBenchmarkData(
  benchamrk_name: string,
  queryParams: Record<string, any> | null
): SWRResponse<CompilerBundleResult, Error> {
  const shouldFetch = !!queryParams;
  return useSWR<CompilerBundleResult, Error>(
    shouldFetch ? [benchamrk_name, queryParams] : null,
    async ([n, qp]) => {
      return postBenchmarkTimeSeriesFetcher<CompilerBundleResult>(
        n as string,
        ["time_series", "table"],
        qp as Record<string, any>
      );
    },
    {
      revalidateOnFocus: false,
      keepPreviousData: true,
      dedupingInterval: 10_000,
    }
  );
}

export const REQUIRED_COMPLIER_LIST_COMMITS_KEYS = [
  "mode",
  "dtype",
  "deviceName",
] as const;

export function useBenchmarkCommitsData(
  benchmarkId: string,
  baseParams: any | null,
  formats: string[] = ["branch"]
): any {
  const shouldFetch = !!baseParams;

  if (baseParams && !baseParams.branches) {
    baseParams.branches = [];
  }

  const keys = shouldFetch
    ? ([benchmarkId, baseParams, formats] as const)
    : null;

  return useSWR<any, Error>(
    keys,
    async ([n, qp, f]) => {
      return listBenchmarkCommits<any>(
        n as string,
        qp as Record<string, any>,
        f as string[]
      );
    },
    {
      revalidateOnFocus: false,
      keepPreviousData: true,
      dedupingInterval: 10_000,
    }
  );
}
