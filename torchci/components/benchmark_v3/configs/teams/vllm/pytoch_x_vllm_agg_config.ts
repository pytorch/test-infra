import { BenchmarkUIConfig } from "../../config_book_types";
import { BenchmarkComparisonPolicyConfig } from "../../helpers/RegressionPolicy";
import { DEFAULT_DASHBOARD_BENCHMARK_INITIAL } from "../defaults/default_dashboard_config";

export const PYTORCH_X_VLLM_AGGREGATE_BENCHMARK_ID =
  "pytroch_x_vllm_aggregated";

// Speedup metrics policy (higher is better)
// Regression if new value < 95% of old value
export const SPEEDUP_COMPARISON_POLICY: BenchmarkComparisonPolicyConfig = {
  target: "speedup",
  type: "ratio",
  ratioPolicy: {
    badRatio: 0.95,
    goodRatio: 1.05,
    direction: "up",
  },
};

// Time metrics policy (lower is better)
// Regression if new value > 115% of old value
export const TIME_COMPARISON_POLICY: BenchmarkComparisonPolicyConfig = {
  target: "time",
  type: "ratio",
  ratioPolicy: {
    badRatio: 1.15,
    goodRatio: 0.85,
    direction: "down",
  },
};

export const PYTORCH_X_VLLM_AGGREGATED_COMPARISON_POLICY = {
  // Speedup metrics (higher is better)
  latency_compile_speedup: SPEEDUP_COMPARISON_POLICY,
  median_itl_ms_compile_speedup: SPEEDUP_COMPARISON_POLICY,
  median_tpot_ms_compile_speedup: SPEEDUP_COMPARISON_POLICY,
  median_ttft_ms_compile_speedup: SPEEDUP_COMPARISON_POLICY,
  tokens_per_second_compile_speedup: SPEEDUP_COMPARISON_POLICY,
  // Time metrics (lower is better) - geomean, compiled
  geomean_avg_cold_compilation_time_compiled: TIME_COMPARISON_POLICY,
  geomean_avg_warm_compilation_time_compiled: TIME_COMPARISON_POLICY,
  geomean_avg_cold_startup_time_compiled: TIME_COMPARISON_POLICY,
  geomean_avg_warm_startup_time_compiled: TIME_COMPARISON_POLICY,
  // Time metrics (lower is better) - geomean, noncompiled
  geomean_avg_cold_compilation_time_noncompiled: TIME_COMPARISON_POLICY,
  geomean_avg_warm_compilation_time_noncompiled: TIME_COMPARISON_POLICY,
  geomean_avg_cold_startup_time_noncompiled: TIME_COMPARISON_POLICY,
  geomean_avg_warm_startup_time_noncompiled: TIME_COMPARISON_POLICY,
};

export const PYTORCH_X_VLLM_AGGREGATED_TITLE_GROUP_MAPPING = {
  // Speedup metrics (each gets its own chart)
  latency_compile_speedup: {
    text: "Latency Compile Speedup (higher is better)",
    description:
      "Speedup ratio of latency with torch.compile enabled vs disabled. Value > 1 means compile improves performance.",
  },
  median_itl_ms_compile_speedup: {
    text: "Median ITL Compile Speedup (higher is better)",
    description:
      "ITL = Inter-Token Latency. Speedup ratio of median time between consecutive tokens with torch.compile enabled vs disabled. Value > 1 means compile improves performance.",
  },
  median_tpot_ms_compile_speedup: {
    text: "Median TPOT Compile Speedup (higher is better)",
    description:
      "TPOT = Time Per Output Token. Speedup ratio of median time to generate each output token with torch.compile enabled vs disabled. Value > 1 means compile improves performance.",
  },
  median_ttft_ms_compile_speedup: {
    text: "Median TTFT Compile Speedup (higher is better)",
    description:
      "TTFT = Time To First Token. Speedup ratio of median time until the first token is generated with torch.compile enabled vs disabled. Value > 1 means compile improves performance.",
  },
  tokens_per_second_compile_speedup: {
    text: "Tokens Per Second Compile Speedup (higher is better)",
    description:
      "Speedup ratio of token generation throughput with torch.compile enabled vs disabled. Value > 1 means compile improves performance.",
  },
  // Grouped metric titles (compiled vs noncompiled in same chart)
  cold_compilation_time: {
    text: "Geomean Cold Compilation Time (lower is better)",
    description:
      "Geometric mean of torch.compile cold compilation time across models. Compares compiled vs non-compiled. Cold = first compilation without cache.",
  },
  warm_compilation_time: {
    text: "Geomean Warm Compilation Time (lower is better)",
    description:
      "Geometric mean of torch.compile warm compilation time across models. Compares compiled vs non-compiled. Warm = compilation with cache available.",
  },
  cold_startup_time: {
    text: "Geomean Cold Startup Time (lower is better)",
    description:
      "Geometric mean of model cold startup time across models. Compares compiled vs non-compiled. Cold = first startup without cache.",
  },
  warm_startup_time: {
    text: "Geomean Warm Startup Time (lower is better)",
    description:
      "Geometric mean of model warm startup time across models. Compares compiled vs non-compiled. Warm = startup with cache available.",
  },
};

export const PYTORCH_X_VLLM_AGGREGATED_RENDER_BOOK = {
  // Speedup metrics
  latency_compile_speedup: {
    displayName: "Latency Speedup",
    unit: { unit: "x" },
  },
  median_itl_ms_compile_speedup: {
    displayName: "Median ITL Speedup",
    unit: { unit: "x" },
  },
  median_tpot_ms_compile_speedup: {
    displayName: "Median TPOT Speedup",
    unit: { unit: "x" },
  },
  median_ttft_ms_compile_speedup: {
    displayName: "Median TTFT Speedup",
    unit: { unit: "x" },
  },
  tokens_per_second_compile_speedup: {
    displayName: "Tokens/sec Speedup",
    unit: { unit: "x" },
  },
  // Absolute values (geomean for compiled and non-compiled)
  geomean_compiled: {
    displayName: "Compiled Geomean",
  },
  geomean_non_compiled: {
    displayName: "Non-compiled Geomean",
  },
  // Cold Compilation time metrics (geomean) - compiled vs noncompiled
  geomean_avg_cold_compilation_time_compiled: {
    displayName: "Cold Compilation (compiled)",
    unit: { type: "time", unit: "s" },
  },
  geomean_avg_cold_compilation_time_noncompiled: {
    displayName: "Cold Compilation (noncompiled)",
    unit: { type: "time", unit: "s" },
  },
  // Warm Compilation time metrics (geomean) - compiled vs noncompiled
  geomean_avg_warm_compilation_time_compiled: {
    displayName: "Warm Compilation (compiled)",
    unit: { type: "time", unit: "s" },
  },
  geomean_avg_warm_compilation_time_noncompiled: {
    displayName: "Warm Compilation (noncompiled)",
    unit: { type: "time", unit: "s" },
  },
  // Cold Startup time metrics (geomean) - compiled vs noncompiled
  geomean_avg_cold_startup_time_compiled: {
    displayName: "Cold Startup (compiled)",
    unit: { type: "time", unit: "s" },
  },
  geomean_avg_cold_startup_time_noncompiled: {
    displayName: "Cold Startup (noncompiled)",
    unit: { type: "time", unit: "s" },
  },
  // Warm Startup time metrics (geomean) - compiled vs noncompiled
  geomean_avg_warm_startup_time_compiled: {
    displayName: "Warm Startup (compiled)",
    unit: { type: "time", unit: "s" },
  },
  geomean_avg_warm_startup_time_noncompiled: {
    displayName: "Warm Startup (noncompiled)",
    unit: { type: "time", unit: "s" },
  },
};

// main config for the compiler benchmark regression page
export const VllmXPytorchBenchmarkAggregatedConfig: BenchmarkUIConfig = {
  benchmarkId: PYTORCH_X_VLLM_AGGREGATE_BENCHMARK_ID,
  apiId: PYTORCH_X_VLLM_AGGREGATE_BENCHMARK_ID,
  title: "Vllm x Pytorch Regression Tracking",
  type: "aggregate",
  dataBinding: {
    initial: {
      ...DEFAULT_DASHBOARD_BENCHMARK_INITIAL,
      benchmarkId: PYTORCH_X_VLLM_AGGREGATE_BENCHMARK_ID,
      filters: {
        device: "cuda",
        arch: "NVIDIA B200",
        deviceName: "cuda||NVIDIA B200",
      },
    },
    required_filter_fields: [],
  },
  dataRender: {
    type: "fanout",
    sideRender: {},
    renders: [
      {
        type: "FanoutBenchmarkComparisonGithubExternalLink",
        title: "Github Link (external)",
        config: {
          description: "See original github runs for left and right runs",
        },
      },
      {
        type: "FanoutBenchmarkTimeSeriesChartSection",
        title: "Time Series Chart Section",
        config: {
          groupByFields: [],
          chartGroup: {
            type: "line",
            groupByFields: ["metric_group"],
            lineKey: ["metric", "device", "arch", "branch"],
            chart: {
              enableDialog: true,
              customizedConfirmDialog: {
                type: "component",
                id: "VllmPrecomputeConfirmDialogContent",
              },
              renderOptions: {
                chartRenderBook: PYTORCH_X_VLLM_AGGREGATED_RENDER_BOOK,
                showLegendDetails: true,
                additionalMetadataList: [
                  "geomean_compiled",
                  "geomean_non_compiled",
                ],
                title_group_mapping:
                  PYTORCH_X_VLLM_AGGREGATED_TITLE_GROUP_MAPPING,
              },
            },
          },
        },
      },
      {
        type: "FanoutBenchmarkTimeSeriesComparisonTableSection",
        title: "Time Series Comparison Table Section",
        config: {
          groupByFields: [],
          filterByFieldValues: {
            metric: [],
          },
          renderOptions: {
            dynamicSize: { lg: 12 },
          },
          tableConfig: {
            primary: {},
            customizedConfirmDialog: {
              type: "component",
              id: "VllmPrecomputeConfirmDialogContent",
            },
            enableDialog: true,
            targetField: "metric",
            comparisonPolicy: PYTORCH_X_VLLM_AGGREGATED_COMPARISON_POLICY,
            renderOptions: {
              tableRenderingBook: PYTORCH_X_VLLM_AGGREGATED_RENDER_BOOK,
              renderMissing: true,
              title_group_mapping:
                PYTORCH_X_VLLM_AGGREGATED_TITLE_GROUP_MAPPING,
            },
          },
        },
      },
    ],
  },
};
