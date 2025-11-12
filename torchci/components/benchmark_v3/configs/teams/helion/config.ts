import { BenchmarkUIConfig } from "../../config_book_types";
import { DEFAULT_DASHBOARD_BENCHMARK_INITIAL } from "../defaults/default_dashboard_config";
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

const RENDER_MAPPING_BOOK = {
  helion_speedup: {
    displayName: "Helion Speedup (Geomean)",
    unit: {
      unit: "x",
    },
  },
  torch_compile_speedup: {
    displayName: "Torch Compile Speedup (Geomean)",
    unit: {
      unit: "x",
    },
  },
  triton_speedup: {
    displayName: "Triton Speedup (Geomean)",
    unit: {
      unit: "x",
    },
  },
  helion_accuracy: {
    hide: true,
  },
  triton_accuracy: {
    hide: true,
  },
  torch_compile_accuracy: {
    hide: true,
  },
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
                {
                  field: "branch",
                  displayName: "branch",
                },
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
        description: "See single view for left and right runs",
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
            tableRenderingBook: RENDER_MAPPING_BOOK,
            flex: {
              primary: 2,
            },
          },
        },
      },
    ],
  },
};
