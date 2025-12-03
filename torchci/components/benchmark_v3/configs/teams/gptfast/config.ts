import { BenchmarkUIConfig } from "../../config_book_types";
import {
  BRANCH_METADATA_COLUMN,
  DEFAULT_DASHBOARD_BENCHMARK_INITIAL,
} from "../defaults/default_dashboard_config";

export const PYTORCH_GPTFAST_BENCHMARK_ID = "pytorch_gptfast_benchmark";

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
    field: "mode",
    displayName: "Mode",
  },
  {
    field: "dtype",
    displayName: "Quantization",
  },
] as const;

const CHART_TITLE_GROUP_MAPPING = {
  token_per_sec: {
    text: "Token per second",
  },
  "memory_bandwidth(GB/s)": {
    text: "Memory Bandwidth (GB/s)",
  },
  "compilation_time(s)": {
    text: "Compilation Time (s)",
  },
  flops_utilization: {
    text: "FLOPs utilization",
  },
};

const RENDER_MAPPING_BOOK = {
  flops_utilization: {
    displayName: "FLOPs utilization",
    unit: {
      type: "time",
      unit: "s",
    },
  },
  token_per_sec: {
    displayName: "Token per second",
  },
  "memory_bandwidth(GB/s)": {
    displayName: "Memory Bandwidth (GB/s)",
  },
  "compilation_time(s)": {
    displayName: "Compilation Time (s)",
  },
};

export const PytorcGptFastBenchmarkDashoboardConfig: BenchmarkUIConfig = {
  benchmarkId: PYTORCH_GPTFAST_BENCHMARK_ID,
  apiId: PYTORCH_GPTFAST_BENCHMARK_ID,
  title: "Gpt-fast Benchmark Dashboard",
  type: "dashboard",
  dataBinding: {
    initial: {
      ...DEFAULT_DASHBOARD_BENCHMARK_INITIAL,
      benchmarkId: PYTORCH_GPTFAST_BENCHMARK_ID,
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
              lineKey: ["extra_key.use_compile", "dtype", "metric", "branch"],
              chart: {
                renderOptions: {
                  showLegendDetails: true,
                  title_group_mapping: CHART_TITLE_GROUP_MAPPING,
                  chartRenderBook: RENDER_MAPPING_BOOK,
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
                tableRenderingBook: RENDER_MAPPING_BOOK,
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
              tableRenderingBook: RENDER_MAPPING_BOOK,
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
        type: "AutoBenchmarkComparisonGithubExternalLink",
        description: "See original github runs for left and right runs",
        config: {},
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
              applyFilterFields: ["model", "mode", "device", "arch", "dtype"],
            },
          },
          extraMetadata: COMPARISON_TABLE_METADATA_COLUMNS,
          renderOptions: {
            tableRenderingBook: RENDER_MAPPING_BOOK,
            missingText: "n/a",
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
