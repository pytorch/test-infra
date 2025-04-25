export const DEFAULT_TRITON_REPOSITORY = "triton-lang/triton";
export const DEFAULT_TRITON_BENCHMARK_NAME = "nightly";
export const DEFAULT_DEVICE_NAME = "NVIDIA H100";

export const BENCHMARK_NAME_METRICS_MAPPING: { [key: string]: any } = {
  nightly: ["tflops-avg"],
  compile_time: ["compile_time-avg"],
};

export const BENCHMARK_METRIC_DASHBOARD_MAPPING: { [key: string]: any } = {
  "tflops-avg": "Average TFLOPS",
  "compile_time-avg": "Average Compile Time",
};

export const BENCHMARK_METRIC_DASHBOARD_Y_LABEL: { [key: string]: any } = {
  "tflops-avg": "TFLOPS",
  "compile_time-avg": "ms",
};
