import { BenchmarkUIConfig } from "../../config_book_types";
import { BenchmarkComparisonPolicyConfig } from "../../helpers/RegressionPolicy";
import {
  BRANCH_METADATA_COLUMN,
  DEFAULT_DASHBOARD_BENCHMARK_INITIAL,
} from "../defaults/default_dashboard_config";

export const PYTORCH_X_VLLM_BENCHMARK_ID = "pytorch_x_vllm_benchmark";

// Comparison policies for time-based metrics (lower is better)
const TIME_METRIC_POLICY: BenchmarkComparisonPolicyConfig = {
  target: "time_metric",
  type: "ratio",
  ratioPolicy: {
    badRatio: 1.2,
    goodRatio: 0.8,
    direction: "down",
  },
};

const COMPARISON_POLICY_BOOK = {
  latency: TIME_METRIC_POLICY,
  median_itl_ms: TIME_METRIC_POLICY,
  median_tpot_ms: TIME_METRIC_POLICY,
  median_ttft_ms: TIME_METRIC_POLICY,
  p99_itl_ms: TIME_METRIC_POLICY,
  p99_tpot_ms: TIME_METRIC_POLICY,
  p99_ttft_ms: TIME_METRIC_POLICY,
};

const COMPARISON_TABLE_METADATA_COLUMNS = [
  {
    field: "device",
    displayName: "Hardware type",
  },
  {
    field: "arch",
    displayName: "Hardware model",
  },
  {
    field: "extra_key.use_compile",
    displayName: "Use Compile",
  },
  {
    field: "extra_key.request_rate",
    displayName: "Request Rate",
  },
  {
    field: "extra_key.tensor_parallel_size",
    displayName: "Tensor Parallel",
  },
  {
    field: "extra_key.input_len",
    displayName: "Input Len",
  },
  {
    field: "extra_key.output_len",
    displayName: "Max Output Len",
  },
] as const;

export const PytorchXVllmBenchmarkDashboardConfig: BenchmarkUIConfig = {
  benchmarkId: PYTORCH_X_VLLM_BENCHMARK_ID,
  apiId: PYTORCH_X_VLLM_BENCHMARK_ID,
  title: "PyTorch x vLLM Benchmark",
  type: "dashboard",
  dataBinding: {
    initial: {
      ...DEFAULT_DASHBOARD_BENCHMARK_INITIAL,
      benchmarkId: PYTORCH_X_VLLM_BENCHMARK_ID,
    },
    required_filter_fields: [],
  },
  dataRender: {
    type: "auto",
    sideRender: {
      RegressionReportFeature: {
        type: "RegressionReportFeature",
        title: "Regression Report Section",
        config: {
          report_id: PYTORCH_X_VLLM_BENCHMARK_ID,
        },
      },
    },
    subSectionRenders: {
      detail_view: {
        filterConstraint: {
          model: {
            disabled: true,
          },
          deviceName: {
            disableOptions: [""],
          },
          mode: {
            disableOptions: [""],
          },
        },
        renders: [
          {
            type: "AutoBenchmarkMarkDownContent",
            config: {
              content:
                "The data is generaterd based on the [pinned vllm commit on PyTorch](https://github.com/pytorch/pytorch/blob/main/.github/ci_commit_pins/vllm.txt), powered by PyTorch [vllm-benchmark workflow](https://github.com/pytorch/pytorch/blob/main/.github/workflows/vllm-benchmark.yml)",
            },
          },
          {
            type: "AutoBenchmarkTimeSeriesChartGroup",
            title: "Metrics Time Series Chart Detail View",
            config: {
              type: "line",
              groupByFields: ["metric"],
              lineKey: [
                "model",
                "extra_key.use_compile",
                "extra_key.request_rate",
                "extra_key.input_len",
                "extra_key.output_len",
                "metric",
                "branch",
              ],
              chart: {
                renderOptions: {
                  showLegendDetails: true,
                },
              },
            },
          },
          {
            type: "AutoBenchmarkTimeSeriesTable",
            title: "Comparison Table Detail View",
            config: {
              primary: {
                fields: ["model"],
                displayName: "Model",
              },
              extraMetadata: COMPARISON_TABLE_METADATA_COLUMNS,
              renderOptions: {
                missingText: "",
                flex: {
                  primary: 2,
                },
              },
            },
          },
          {
            type: "AutoBenchmarkRawDataTable",
            title: "Raw Data Table",
            config: {
              extraMetadata: [
                BRANCH_METADATA_COLUMN,
                ...COMPARISON_TABLE_METADATA_COLUMNS,
              ],
            },
          },
        ],
      },
    },
    renders: [
      {
        type: "AutoBenchmarkMarkDownContent",
        config: {
          content:
            "The data is generaterd based on the [pinned vllm commit on PyTorch](https://github.com/pytorch/pytorch/blob/main/.github/ci_commit_pins/vllm.txt), powered by PyTorch [vllm-benchmark workflow](https://github.com/pytorch/pytorch/blob/main/.github/workflows/vllm-benchmark.yml) + [the benchmark configs](https://github.com/pytorch/pytorch-integration-testing/tree/main/vllm-benchmarks/benchmarks)",
        },
      },

      {
        type: "AutoBenchmarkPairwiseTable",
        title: "Comparison Table",
        config: {
          primary: {
            fields: ["model"],
            displayName: "Model",
            navigation: {
              type: "subSectionRender",
              value: "detail_view",
              applyFilterFields: ["model", "device", "arch"],
            },
          },
          extraMetadata: COMPARISON_TABLE_METADATA_COLUMNS,
          comparisonPolicy: COMPARISON_POLICY_BOOK,
          renderOptions: {
            missingText: "none",
            bothMissingText: "",
            flex: {
              primary: 2,
            },
          },
        },
      },
    ],
  },
};
