import useSWR, { SWRResponse } from "swr";
import { BundleResult } from "../type";
import { listBenchmarkCommits, postBenchmarkTimeSeriesFetcher } from "./api";

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

// --- Hook wrapper ---
export function useBenchmarkData(
  benchamrk_name: string,
  queryParams: Record<string, any> | null
): SWRResponse<BundleResult, Error> {
  const shouldFetch = !!queryParams;
  return useSWR<BundleResult, Error>(
    shouldFetch ? [benchamrk_name, queryParams] : null,
    async ([n, qp]) => {
      return postBenchmarkTimeSeriesFetcher<BundleResult>(
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
