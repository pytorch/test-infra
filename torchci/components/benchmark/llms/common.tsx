import { BranchAndCommit } from "lib/types";

export const BENCHMARKS = ["gpt_fast_benchmark"];
export const DEFAULT_MODEL_NAME = "All Models";
export const SCALE = 2;
export const METRIC_DISPLAY_HEADERS: { [k: string]: string } = {
  "memory_bandwidth(GB/s)": "Memory bandwidth (GB/s)",
  token_per_sec: "Token per second",
};
export const METRIC_DISPLAY_SHORT_HEADERS: { [k: string]: string } = {
  "memory_bandwidth(GB/s)": "Bandwidth",
  token_per_sec: "TPS",
};
export const DEFAULT_DEVICE_NAME = "All Devices";
export const DEFAULT_REPO_NAME = "pytorch/pytorch";

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
}

export interface BranchAndCommitPerfData extends BranchAndCommit {
  data: LLMsBenchmarkData[];
}
