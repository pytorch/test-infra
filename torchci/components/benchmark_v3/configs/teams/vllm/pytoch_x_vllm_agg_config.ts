import { BenchmarkUIConfig } from "../../config_book_types";
import { DEFAULT_DASHBOARD_BENCHMARK_INITIAL } from "../defaults/default_dashboard_config";

export const PYTORCH_X_VLLM_AGGREGATE_BENCHMARK_ID =
  "pytroch_x_vllm_aggregated";

const CHART_METADATA_COLUMNS = [
  {
    field: "geomean_compiled",
    displayName: "Use Compile Geomean",
  },
  {
    field: "geomean_non_compiled",
    displayName: "Use Non-Compile Geomean",
  },
] as const;

const TITLE_GROUP_MAPPING = {
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
};

const RENDER_BOOK = {
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
        arch: "NVIDIA H100 80GB HBM3",
        deviceName: "cuda||NVIDIA H100 80GB HBM3",
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
            groupByFields: ["metric"],
            lineKey: ["device", "arch", "branch"],
            chart: {
              enableDialog: true,
              customizedConfirmDialog: {
                type: "component",
                id: "VllmPrecomputeConfirmDialogContent",
              },
              renderOptions: {
                chartRenderBook: RENDER_BOOK,
                showLegendDetails: true,
                additionalMetadataList: [
                  "geomean_compiled",
                  "geomean_non_compiled",
                ],
                title_group_mapping: TITLE_GROUP_MAPPING,
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
            comparisonPolicy: {},
            renderOptions: {
              tableRenderingBook: RENDER_BOOK,
              renderMissing: true,
              title_group_mapping: TITLE_GROUP_MAPPING,
            },
          },
        },
      },
    ],
  },
};
