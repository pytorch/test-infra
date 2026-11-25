import { BenchmarkUIConfig } from "../../config_book_types";
import {
  BRANCH_METADATA_COLUMN,
  DEFAULT_DASHBOARD_BENCHMARK_INITIAL,
} from "../defaults/default_dashboard_config";
import { DEFAULT_SINGLE_VIEW_BENCHMARK_INITIAL } from "../defaults/default_single_view_config";

export const PYTORCH_HELION_BENCHMARK_ID = "pytorch_helion";

const initialOptions = {
  ...DEFAULT_DASHBOARD_BENCHMARK_INITIAL,
  benchmarkId: PYTORCH_HELION_BENCHMARK_ID,
};

const DETAIL_VIEW_METADATA_COLUMNS = [
  {
    field: "device",
    displayName: "Hardware type",
  },
  {
    field: "arch",
    displayName: "Hardware model",
  },
] as const;

// Metric definitions (single source of truth)
const HIDDEN = { hide: true } as const;
const SPEEDUP_UNIT = { unit: { unit: "x" } } as const;

const METRIC_DEFS = {
  helion_speedup: { displayName: "Helion Speedup (Geomean)", ...SPEEDUP_UNIT },
  torch_compile_speedup: {
    displayName: "Torch Compile Speedup (Geomean)",
    ...SPEEDUP_UNIT,
  },
  triton_speedup: { displayName: "Triton Speedup (Geomean)", ...SPEEDUP_UNIT },
  helion_compile_time_s: {
    displayName: "Helion Compile Time (s)",
    unit: { unit: "s" },
  },
};

// Combined render book for detail views and charts (shows everything except accuracy)
const RENDER_MAPPING_BOOK = {
  ...METRIC_DEFS,
  helion_accuracy: HIDDEN,
  triton_accuracy: HIDDEN,
  torch_compile_accuracy: HIDDEN,
};

// Speedup comparison table (hides compile time + accuracy)
const SPEEDUP_RENDER_BOOK = {
  ...RENDER_MAPPING_BOOK,
  helion_compile_time_s: HIDDEN,
};

// Compile time comparison table (hides speedup + accuracy)
const COMPILE_TIME_RENDER_BOOK = {
  ...RENDER_MAPPING_BOOK,
  helion_speedup: HIDDEN,
  torch_compile_speedup: HIDDEN,
  triton_speedup: HIDDEN,
};

export const PytorchHelionSingleConfig: BenchmarkUIConfig | any = {
  benchmarkId: PYTORCH_HELION_BENCHMARK_ID,
  apiId: "pytorch_helion",
  title: "Helion Single View",
  dataBinding: {
    initial: DEFAULT_SINGLE_VIEW_BENCHMARK_INITIAL,
    required_filter_fields: [],
  },
  dataRender: {
    type: "auto",
    sideRender: {
      RegressionReportFeature: {
        type: "RegressionReportFeature",
        title: "Regression Report Section",
        config: {
          report_id: PYTORCH_HELION_BENCHMARK_ID,
        },
      },
    },
    renders: [
      {
        type: "AutoBenchmarkSingleDataTable",
        title: "Single Run Table",
        config: {
          extraMetadata: [
            {
              field: "model",
              displayName: "Model",
            },
            {
              field: "arch",
              displayName: "Hardware Type",
            },
          ],
          renderOptions: {
            tableRenderingBook: RENDER_MAPPING_BOOK,
            highlightPolicy: {
              direction: "row",
              regex: "_speedup$",
              policy: "max",
            },
          },
        },
      },
    ],
  },
};

export const PytorchHelionDashboardConfig: BenchmarkUIConfig = {
  benchmarkId: PYTORCH_HELION_BENCHMARK_ID,
  apiId: "pytorch_helion",
  title: "Pytorch Helion Dashboard",
  type: "dashboard",
  dataBinding: {
    initial: initialOptions,
    required_filter_fields: [],
  },
  dataRender: {
    type: "auto",
    sideRender: {
      RegressionReportFeature: {
        type: "RegressionReportFeature",
        title: "Regression Report Section",
        config: {
          report_id: PYTORCH_HELION_BENCHMARK_ID,
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
              lineKey: ["metric", "branch"],
              chart: {
                renderOptions: {
                  chartRenderBook: RENDER_MAPPING_BOOK,
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
              extraMetadata: DETAIL_VIEW_METADATA_COLUMNS,
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
              extraMetadata: [
                BRANCH_METADATA_COLUMN,
                ...DETAIL_VIEW_METADATA_COLUMNS,
              ],
              renderOptions: {
                tableRenderingBook: RENDER_MAPPING_BOOK,
              },
            },
          },
        ],
      },
    },
    renders: [
      {
        type: "AutoBenchmarkSingleViewNavigation",
        title: "Benchmark Single View",
        description: "See single view for left and right runs",
        config: {},
      },
      {
        type: "AutoBenchmarkComparisonGithubExternalLink",
        title: "Github Link (external)",
        description: "See original github runs for left and right runs",
        config: {},
      },
      {
        type: "AutoBenchmarkPairwiseTable",
        title: "Speedup Comparison",
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
          extraMetadata: [
            {
              field: "arch",
              displayName: "Hardware model",
            },
          ],
          renderOptions: {
            tableRenderingBook: SPEEDUP_RENDER_BOOK,
            highlightPolicy: {
              direction: "row",
              regex: "_speedup$",
              policy: "max",
            },
            flex: {
              primary: 2,
            },
          },
        },
      },
      {
        type: "AutoBenchmarkPairwiseTable",
        title: "Compile Time Comparison",
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
          extraMetadata: [
            {
              field: "arch",
              displayName: "Hardware model",
            },
          ],
          renderOptions: {
            tableRenderingBook: COMPILE_TIME_RENDER_BOOK,
            flex: {
              primary: 2,
            },
          },
        },
      },
    ],
  },
};
