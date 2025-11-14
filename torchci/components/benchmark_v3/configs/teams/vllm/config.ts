import { BenchmarkUIConfig } from "../../config_book_types";
import {
  BRANCH_METADATA_COLUMN,
  DEFAULT_DASHBOARD_BENCHMARK_INITIAL,
} from "../defaults/default_dashboard_config";

export const PYTORCH_VLLM_BENCHMARK_ID = "vllm_benchmark";

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

export const PytorchVllmBenchmarkDashoboardConfig: BenchmarkUIConfig = {
  benchmarkId: PYTORCH_VLLM_BENCHMARK_ID,
  apiId: PYTORCH_VLLM_BENCHMARK_ID,
  title: "VLLM V1 Benchmark",
  type: "dashboard",
  dataBinding: {
    initial: {
      ...DEFAULT_DASHBOARD_BENCHMARK_INITIAL,
      benchmarkId: PYTORCH_VLLM_BENCHMARK_ID,
    },
    required_filter_fields: [],
  },
  dataRender: {
    type: "auto",
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
