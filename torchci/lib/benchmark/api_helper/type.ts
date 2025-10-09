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

export interface BundleResult {
  data: {
    data: any;
    time_range: any;
    total_raw_rows: number;
  };
}

export interface CommitSamplingInfo {
  origin?: number;
  result?: number;
}

export interface CommitResult {
  data: any[];
  origin?: any[];
  is_sampled?: boolean;
  sampling_info?: CommitSamplingInfo;
}
