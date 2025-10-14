import useSWR, { SWRConfiguration, SWRResponse } from "swr";
import { BundleResult } from "../type";
import {
  getBenchmarkRegressionReport,
  listBenchmarkCommits,
  listBenchmarkRegressionReport,
  postBenchmarkTimeSeriesFetcher,
} from "./api";

export function useBenchmarkCommitsData(
  benchmarkId: string,
  baseParams: any | null,
  formats: string[] = ["branch"]
): any {
  const shouldFetch = !!baseParams;

  if (baseParams && !baseParams.branches) {
    baseParams.branches = [];
  }

  return useApi(
    listBenchmarkCommits,
    [benchmarkId, baseParams, formats],
    {
      refreshInterval: 60 * 60 * 1000,
      revalidateOnFocus: false,
      keepPreviousData: true,
      dedupingInterval: 10_000,
    },
    shouldFetch
  );
}

// --- Hook wrapper ---
export function useBenchmarkData(
  benchamrk_name: string,
  queryParams: Record<string, any> | null,
  formats: string[] = ["time_series", "table"]
): SWRResponse<BundleResult, Error> {
  const shouldFetch = !!queryParams;
  return useApi<BundleResult>(
    postBenchmarkTimeSeriesFetcher,
    [benchamrk_name, formats, queryParams],
    {
      revalidateOnFocus: false,
      keepPreviousData: true,
      dedupingInterval: 10_000,
    },
    shouldFetch
  );
}

export function useListBenchmarkRegressionReportsData(
  report_id: string,
  limit: number = 10,
  refreshInterval: number = 12 * 60 * 60 * 1000 // refresh every 12 hour by default
): any {
  return useApi(listBenchmarkRegressionReport, [report_id, limit], {
    refreshInterval: refreshInterval, // refresh every 12 hour
    revalidateOnFocus: false,
  });
}

export function useGetBenchmarkRegressionReportData(id: string): any {
  return useApi(getBenchmarkRegressionReport, [id], {
    refreshInterval: 12 * 60 * 60 * 1000, // refresh every 12 hour
    revalidateOnFocus: false,
  });
}

/**
 * Generic SWR hook that derives the cache key from the function name + args.
 * You can pass an `enabled` flag (like react-query) to disable fetching until ready.
 */
export function useApi<T>(
  apiFunc: (...args: any[]) => Promise<T>,
  args: any[] = [],
  options?: SWRConfiguration,
  enabled: boolean = true
) {
  // build the key only if enabled
  const key = enabled ? [apiFunc.name || "anon", ...args] : null;

  return useSWR<T>(
    key,
    key ? ([, ...params]) => apiFunc(...params) : null,
    options
  );
}
