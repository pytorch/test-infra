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

// main config for the compiler benchmark regression page
export const VllmXPytorchBenchmarkAggregatedConfig: BenchmarkUIConfig = {
  benchmarkId: PYTORCH_X_VLLM_AGGREGATE_BENCHMARK_ID,
  apiId: PYTORCH_X_VLLM_AGGREGATE_BENCHMARK_ID,
  title: "Compiler Inductor Regression Tracking",
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
                chartRenderBook: {},
                showLegendDetails: true,
                additionalMetadataList: [
                  "geomean_compiled",
                  "geomean_non_compiled",
                ],
                title_group_mapping: {},
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
              tableRenderingBook: {},
              renderMissing: true,
            },
          },
        },
      },
    ],
  },
};
