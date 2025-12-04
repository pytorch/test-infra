import { BenchmarkUIConfig } from "../../config_book_types";
import {
  BRANCH_METADATA_COLUMN,
  DEFAULT_COMPARISON_TABLE_METADATA_COLUMNS,
  DEFAULT_DASHBOARD_BENCHMARK_INITIAL,
} from "../defaults/default_dashboard_config";

export const PYTORCH_AO_MICRO_API_BENCHMARK_ID = "torchao_micro_api_benchmark";

const COMPARISON_TABLE_METADATA_COLUMNS = [
  ...DEFAULT_COMPARISON_TABLE_METADATA_COLUMNS,
  {
    field: "dtype",
    displayName: "Quant Type",
  },
  {
    field: "extra_key.use_compile",
    displayName: "Use Compile",
  },
] as const;

export const PytorcAoMicroApiBenchmarkDashoboardConfig: BenchmarkUIConfig = {
  benchmarkId: PYTORCH_AO_MICRO_API_BENCHMARK_ID,
  apiId: PYTORCH_AO_MICRO_API_BENCHMARK_ID,
  title: "TorchAo Micro Api Benchmark",
  type: "dashboard",
  dataBinding: {
    initial: {
      ...DEFAULT_DASHBOARD_BENCHMARK_INITIAL,
      benchmarkId: PYTORCH_AO_MICRO_API_BENCHMARK_ID,
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
          report_id: PYTORCH_AO_MICRO_API_BENCHMARK_ID,
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
            type: "AutoBenchmarkTimeSeriesChartGroup",
            title: "Metrics Time Series Chart Detail View",
            config: {
              type: "line",
              groupByFields: ["metric"],
              lineKey: ["extra_key.use_compile", "dtype", "metric", "branch"],
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
        type: "AutoBenchmarkShortcutCardList",
        title: "Dtype Lists",
        config: {
          filters: ["dtype"],
        },
      },
      {
        type: "AutoBenchmarkComparisonGithubExternalLink",
        title: "Github Runs",
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
            flex: {
              primary: 2,
            },
          },
        },
      },
    ],
  },
};
