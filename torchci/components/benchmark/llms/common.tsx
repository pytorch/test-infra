import { BranchAndCommit } from "lib/types";

export const REPOS = ["pytorch/pytorch", "pytorch/executorch", "pytorch/ao"];
export const REPO_TO_BENCHMARKS: { [k: string]: string[] } = {
  "pytorch/pytorch": ["PyTorch gpt-fast benchmark"],
  "pytorch/executorch": ["ExecuTorch"],
  "pytorch/ao": ["TorchAO benchmark"],
  "vllm-project/vllm": ["vLLM benchmark"],
};
export const EXCLUDED_METRICS: string[] = ["load_status"];
export const DEFAULT_MODEL_NAME = "All Models";
export const SCALE = 2;
export const METRIC_DISPLAY_HEADERS: { [k: string]: string } = {
  "memory_bandwidth(GB/s)": "Memory bandwidth (GB/s)",
  token_per_sec: "Token per second",
  flops_utilization: "FLOPs utilization",
  "compilation_time(s)": "Compilation Time (s)",
  compile_vs_eager_speedup: "Compile vs eager speedup",
  autoquant_vs_compile_speedup: "Autoquant vs compile speedup",
  eager_speedup: "Eager speedup",
};
// The variable name is a bit dumb, but it tells if a higher metric value
// is good or bad so that we can highlight it on the dashboard accordingly.
// For example, higher TPS is good while higher compilation time isn't
export const IS_INCREASING_METRIC_VALUE_GOOD: { [k: string]: boolean } = {
  "memory_bandwidth(GB/s)": true,
  token_per_sec: true,
  flops_utilization: true,
  "compilation_time(s)": false,
  speedup: true,
};
export const METRIC_DISPLAY_SHORT_HEADERS: { [k: string]: string } = {
  "memory_bandwidth(GB/s)": "Bandwidth",
  token_per_sec: "TPS",
  flops_utilization: "FLOPs",
  "compilation_time(s)": "CompTime",
};
export const DEFAULT_DEVICE_NAME = "All Devices";
export const DEFAULT_ARCH_NAME = "All Platforms";
export const DEFAULT_DTYPE_NAME = "All DType";
export const DEFAULT_BACKEND_NAME = "All Backends";

// Only used by ExecuTorch for now
export const ARCH_NAMES: { [k: string]: string[] } = {
  "pytorch/executorch": ["Android", "iOS"],
};

// Relative thresholds
export const RELATIVE_THRESHOLD = 0.05;

export interface LLMsBenchmarkData {
  granularity_bucket: string;
  model: string;
  backend: string;
  origins: string[];
  workflow_id: number;
  job_id: number;
  metric: string;
  actual: number;
  target: number;
  dtype: string;
  device: string;
  arch: string;
  display?: string;
  use_torch_compile?: boolean;
}

export interface BranchAndCommitPerfData extends BranchAndCommit {
  data: LLMsBenchmarkData[];
}
