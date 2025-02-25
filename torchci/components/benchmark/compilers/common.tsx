import { BranchAndCommit, CompilerPerformanceData } from "lib/types";

// Relative thresholds
export const RELATIVE_THRESHOLD = 0.05;

// Thresholds
export const ACCURACY_THRESHOLD = 90.0;
export const SPEEDUP_THRESHOLD = 0.95;
export const COMPRESSION_RATIO_THRESHOLD = 0.9;

// This will highlight the regression if peak memory usage increases more than
// 20% (copy from D51336330)
export const PEAK_MEMORY_USAGE_RELATIVE_THRESHOLD = 0.2;

// Headers
export const DIFF_HEADER = "Base value (L) → New value (R)";

// After https://github.com/pytorch/pytorch/pull/96986, there is no perf data
// for eager and aot_eager because they are not run anymore (not needed)
export const COMPILER_NAMES_TO_DISPLAY_NAMES: { [k: string]: string } = {
  inductor: "cudagraphs",
  inductor_with_cudagraphs: "cudagraphs",
  inductor_dynamic: "cudagraphs_dynamic",
  inductor_no_cudagraphs: "default",
  inductor_cpp_wrapper: "cpp_wrapper",
  inductor_aot_inductor: "aot_inductor",
  inductor_with_cudagraphs_freezing: "cudagraphs_freezing",
  inductor_cudagraphs_low_precision: "cudagraphs_low_precision",
  inductor_export: "export",
  inductor_eager: "eager",
};
export const DISPLAY_NAMES_TO_COMPILER_NAMES: { [k: string]: string } = {
  inductor_default: "inductor_no_cudagraphs",
  default: "inductor_no_cudagraphs",
  cudagraphs: "inductor_with_cudagraphs",
  cudagraphs_dynamic: "inductor_dynamic",
  cpp_wrapper: "inductor_cpp_wrapper",
  aot_inductor: "inductor_aot_inductor",
  cudagraphs_freezing: "inductor_with_cudagraphs_freezing",
  cudagraphs_low_precision: "inductor_cudagraphs_low_precision",
  export: "inductor_export",
  eager: "inductor_eager",
};
export const BLOCKLIST_COMPILERS = ["aot_eager"];
export const PASSING_ACCURACY = ["pass", "pass_due_to_skip", "eager_variation"];

// The number of digit after decimal to display on the summary page
export const SCALE = 2;

export interface BranchAndCommitPerfData extends BranchAndCommit {
  data: CompilerPerformanceData[];
}

// A help link to explain the metrics used in the dashboard
export const HELP_LINK =
  "https://pytorch.org/docs/main/torch.compiler_performance_dashboard.html";

export const DTYPES = ["amp", "float16", "bfloat16", "quant", "notset"];

export const DEFAULT_DEVICE_NAME = "cuda (h100)";
// TODO (huydhn): there is a way to avoid hard-coding dtypes and devices like how
// the LLM micro-benchmark page is implemented
export const DISPLAY_NAMES_TO_DEVICE_NAMES: { [k: string]: string } = {
  "cuda (a100)": "cuda",
  "cuda (h100)": "cuda_h100",
  "cpu (x86)": "cpu_x86",
  "cpu (aarch64)": "cpu_aarch64",
  "rocm (mi300x)": "rocm",
  mps: "mps",
};
export const DISPLAY_NAMES_TO_WORKFLOW_NAMES: { [k: string]: string } = {
  "cuda (a100)": "inductor-A100-perf-nightly",
  "cuda (h100)": "inductor-perf-nightly-h100",
  "cpu (x86)": "inductor-perf-nightly-x86",
  "cpu (aarch64)": "inductor-perf-nightly-aarch64",
  rocm: "inductor-perf-nightly-rocm",
  mps: "inductor-perf-nightly-macos",
};

export const DEFAULT_HIGHLIGHT_KEY = "none";
export const DISPLAY_KEYS_TO_HIGHLIGHT: { [k: string]: string } = {
  None: DEFAULT_HIGHLIGHT_KEY,
  Max_autotune: "max_autotune",
};
