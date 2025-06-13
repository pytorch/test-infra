import { BranchAndCommit } from "lib/types";

export const REPOS = ["pytorch/pytorch", "pytorch/executorch", "pytorch/ao"];
export const REPO_TO_BENCHMARKS: { [k: string]: string[] } = {
  "pytorch/pytorch": ["PyTorch gpt-fast benchmark"],
  "pytorch/executorch": ["ExecuTorch"],
  "pytorch/ao": ["TorchAO benchmark"],
  "vllm-project/vllm": ["vLLM benchmark"],
};
export const EXCLUDED_METRICS: string[] = [
  "load_status",
  "mean_itl_ms",
  "mean_tpot_ms",
  "mean_ttft_ms",
  "std_itl_ms",
  "std_tpot_ms",
  "std_ttft_ms",
  "cold_compile_time(s)",
  "warm_compile_time(s)",
  "speedup_pct",
  // TODO (huydhn): Hide generate_time(ms) metric temporarily because of
  // https://github.com/pytorch/executorch/issues/8576#issuecomment-2669706120
  "generate_time(ms)",
];
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
  latency: "Latency (s)",
  median_itl_ms: "Median ITL (ms)",
  median_tpot_ms: "Median TPOT (ms)",
  median_ttft_ms: "Median TTFT (ms)",
  p99_itl_ms: "p99 ITL (ms)",
  p99_tpot_ms: "p99 TPOT (ms)",
  p99_ttft_ms: "p99 TTFT (ms)",
  requests_per_second: "Requests/s",
  tokens_per_second: "Tokens/s",
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
  "avg_inference_latency(ms)": false,
  "trimmean_inference_latency(ms)": false,
  "model_load_time(ms)": false,
  "peak_inference_mem_usage(mb)": false,
  "peak_load_mem_usuage(mb)": false,
  "generate_time(ms)": false,
  latency: false,
  median_itl_ms: false,
  median_tpot_ms: false,
  median_ttft_ms: false,
  p99_itl_ms: false,
  p99_tpot_ms: false,
  p99_ttft_ms: false,
  requests_per_second: true,
  tokens_per_second: true,
  "Cold compile time (s)": false,
  "Warm compile time (s)": false,
  Speedup: true,
  "Speedup (%)": true,
};
export const METRIC_DISPLAY_SHORT_HEADERS: { [k: string]: string } = {
  "memory_bandwidth(GB/s)": "Bandwidth",
  token_per_sec: "TPS",
  flops_utilization: "FLOPs",
  "compilation_time(s)": "CompTime",
  "avg_inference_latency(ms)": "InferenceTime",
  "model_load_time(ms)": "LoadTime",
  "peak_inference_mem_usage(mb)": "InferenceMem",
  "peak_load_mem_usuage(mb)": "LoadMem",
  "generate_time(ms)": "GenerateTime",
  "Cold compile time (s)": "ColdCompTime",
  "Warm compile time (s)": "WarmCompTime",
};
export const UNIT_FOR_METRIC: { [k: string]: string } = {
  "Speedup (%)": "%",
};

export const DEFAULT_DEVICE_NAME = "All Devices";
export const DEFAULT_ARCH_NAME = "All Platforms";
export const DEFAULT_DTYPE_NAME = "All DType";
export const DEFAULT_MODE_NAME = "All Modes";
export const DEFAULT_BACKEND_NAME = "All Backends";

// Only used by ExecuTorch for now
export const ARCH_NAMES: { [k: string]: string[] } = {
  "pytorch/executorch": ["Android", "iOS"],
};

// Relative thresholds
export const RELATIVE_THRESHOLD = 0.1;

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
  mode?: string;
  dtype: string;
  device: string;
  arch: string;
  display?: string;
  extra?: { [key: string]: string };
  metadata_info?: { [key: string]: string };
}

export interface BranchAndCommitPerfData extends BranchAndCommit {
  data: LLMsBenchmarkData[];
}
