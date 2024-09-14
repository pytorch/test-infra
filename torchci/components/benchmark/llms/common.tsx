import { BranchAndCommit } from "lib/types";

export const BENCHMARKS = ["gpt_fast_benchmark"];
export const DEFAULT_MODEL_NAME = "All Models";
export const SCALE = 2;
export const METRIC_DISPLAY_HEADERS: { [k: string]: string } = {
  "memory_bandwidth(GB/s)": "Memory bandwidth (GB/s)",
  token_per_sec: "Token per second",
  flops_utilization: "FLOPs utilization",
  "compilation_time(s)": "Compilation Time (s)",
};
// The variable name is a bit dumb, but it tells if a higher metric value
// is good or bad so that we can highlight it on the dashboard accordingly.
// For example, higher TPS is good while higher compilation time isn't
export const IS_INCREASING_METRIC_VALUE_GOOD: { [k: string]: boolean } = {
  "memory_bandwidth(GB/s)": true,
  token_per_sec: true,
  flops_utilization: true,
  "compilation_time(s)": false,
};
export const METRIC_DISPLAY_SHORT_HEADERS: { [k: string]: string } = {
  "memory_bandwidth(GB/s)": "Bandwidth",
  token_per_sec: "TPS",
  flops_utilization: "FLOPs",
  "compilation_time(s)": "CompTime",
};
export const DEFAULT_DEVICE_NAME = "All Devices";
export const DEFAULT_DTYPE_NAME = "All DType";

// Relative thresholds
export const RELATIVE_THRESHOLD = 0.05;

export interface LLMsBenchmarkData {
  granularity_bucket: string;
  name: string;
  workflow_id: number;
  job_id?: number;
  metric: string;
  actual: number;
  target: number;
  dtype: string;
  device: string;
  display?: string;
}

export interface BranchAndCommitPerfData extends BranchAndCommit {
  data: LLMsBenchmarkData[];
}
