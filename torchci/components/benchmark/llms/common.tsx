import { BranchAndCommit } from "lib/types";

export const DEFAULT_QUANTIZATION = "bfloat16";
export const BENCHMARKS = ["gpt_fast_benchmark"];
export const DEFAULT_MODEL_NAME = "All Models";
export const SCALE = 2;

// Relative thresholds
export const RELATIVE_THRESHOLD = 0.05;

export interface LLMsBenchmarkData {
  granularity_bucket: string;
  name: string;
  workflow_id: number;
  job_id?: number;
  quantization: string;
  "token_per_sec[target]": number;
  "token_per_sec[actual]": number;
  "memory_bandwidth[target]": number;
  "memory_bandwidth[actual]": number;
}

export interface BranchAndCommitPerfData extends BranchAndCommit {
  data: LLMsBenchmarkData[];
}
