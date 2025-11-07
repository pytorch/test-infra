import { useBenchmarkBook } from "components/benchmark_v3/configs/benchmark_config_book";
import { BenchmarkPageType } from "components/benchmark_v3/configs/config_book_types";
import { useDashboardSelector } from "lib/benchmark/store/benchmark_dashboard_provider";
import useSWR, { SWRConfiguration, SWRResponse } from "swr";
import { BundleResult } from "../backend/common/type";
import {
  getBenchmarkRegressionReport,
  listBenchmarkCommits,
  listBenchmarkRegressionReport,
  postBenchmarkMetadataFetcher,
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
export function useBenchmarkTimeSeriesData(
  benchmark_id: string,
  queryParams: Record<string, any> | null,
  formats: string[] = ["time_series", "table"]
): SWRResponse<BundleResult, Error> {
  const shouldFetch = !!queryParams;
  return useApi<BundleResult>(
    postBenchmarkTimeSeriesFetcher,
    [benchmark_id, formats, queryParams],
    {
      revalidateOnFocus: false,
      keepPreviousData: true,
      dedupingInterval: 10_000,
    },
    shouldFetch
  );
}

export function useListBenchmarkMetadata(
  benchmark_id: string,
  queryParams: Record<string, any> | null
): SWRResponse<any, Error> {
  const shouldFetch = !!queryParams;
  return useApi(
    postBenchmarkMetadataFetcher,
    [benchmark_id, queryParams],
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
    ...limitErrorRetrySWR,
  });
}

export function useGetBenchmarkRegressionReportData(id: string): any {
  return useApi(getBenchmarkRegressionReport, [id], {
    refreshInterval: 12 * 60 * 60 * 1000, // refresh every 12 hour
    revalidateOnFocus: false,
    ...limitErrorRetrySWR,
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

  return useSWR<T>(key, key ? ([, ...params]) => apiFunc(...params) : null, {
    ...limitErrorRetrySWR,
    ...options,
  });
}

/** Unified hook: collects dashboard + config info in one place
 *  this is a read-only hook, mainly used for UI components that
 *  only needs to read committed state
 */
export function useBenchmarkCommittedContext() {
  // read dashboard state
  const {
    repo,
    type,
    benchmarkId,
    benchmarkName,
    committedTime,
    committedFilters,
    committedLbranch,
    committedRbranch,
    committedMaxSampling,
    lcommit,
    rcommit,
  } = useDashboardSelector((s) => ({
    repo: s.repo,
    type: s.type,
    benchmarkName: s.benchmarkName,
    benchmarkId: s.benchmarkId,
    committedTime: s.committedTime,
    committedFilters: s.committedFilters,
    committedLbranch: s.committedLbranch,
    committedRbranch: s.committedRbranch,
    committedMaxSampling: s.committedMaxSampling,
    lcommit: s.lcommit,
    rcommit: s.rcommit,
  }));

  const configHandler = useBenchmarkConfigBook(benchmarkId, type);
  const config = configHandler;
  const requiredFilters = config.dataBinding?.raw?.required_filter_fields ?? [];
  const dataRender = config?.raw?.dataRender ?? null;

  return {
    repo,
    benchmarkId,
    benchmarkName,
    committedTime,
    committedFilters,
    committedLbranch,
    committedRbranch,
    committedMaxSampling,
    lcommit,
    rcommit,
    config,
    configHandler,
    requiredFilters,
    dataRender,
  };
}

// safely get config handler from benchmark book
export function useBenchmarkConfigBook(
  benchmarkId: string,
  type: BenchmarkPageType
) {
  const getConfig = useBenchmarkBook((s) => s.getConfig);
  return getConfig(benchmarkId, type);
}

const limitErrorRetrySWR: SWRConfiguration = {
  onErrorRetry: (
    error: any,
    key: any,
    config: any,
    revalidate,
    { retryCount }
  ) => {
    if (error.status === 404) return;
    if (retryCount >= 2) return;
  },
};
