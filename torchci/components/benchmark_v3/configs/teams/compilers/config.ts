import {
  DEFAULT_DEVICE_NAME,
  DISPLAY_NAMES_TO_ARCH_NAMES,
  DISPLAY_NAMES_TO_DEVICE_NAMES,
} from "components/benchmark/compilers/common";
import { SUITES } from "components/benchmark/compilers/SuitePicker";
import { DEFAULT_MODE, MODES } from "components/benchmark/ModeAndDTypePicker";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { REQUIRED_COMPLIER_LIST_COMMITS_KEYS } from "lib/benchmark/api_helper/backend/compilers/helpers/type";
import { DISPLAY_NAMES_TO_COMPILER_NAMES } from "../../../../benchmark/compilers/common";
import { BenchmarkUIConfig } from "../../config_book_types";
import { BenchmarkComparisonPolicyConfig } from "../../helpers/RegressionPolicy";
import {
  QueryParameterConverter,
  QueryParameterConverterInputs,
} from "../../utils/dataBindingRegistration";
import { toNumberArray } from "../../utils/helper_methods";
import {
  BRANCH_METADATA_COLUMN,
  DEFAULT_DASHBOARD_BENCHMARK_INITIAL,
} from "../defaults/default_dashboard_config";
dayjs.extend(utc);

const PASSRATE_COMPARISON_POLICY: BenchmarkComparisonPolicyConfig = {
  target: "passrate",
  type: "ratio",
  ratioPolicy: {
    badRatio: 0.95,
    goodRatio: 1.05,
    direction: "up",
  },
};
const GEOMEAN_COMPARISON_POLICY: BenchmarkComparisonPolicyConfig = {
  target: "geomean_speedup",
  type: "ratio",
  ratioPolicy: {
    badRatio: 0.95,
    goodRatio: 1.05,
    direction: "up",
  },
};
const COMPILATION_LATENCY_COMPARISON_POLICY: BenchmarkComparisonPolicyConfig = {
  target: "compilation_latency",
  type: "ratio",
  ratioPolicy: {
    badRatio: 1.15,
    goodRatio: 0.85,
    direction: "down",
  },
};
const COMPRESSION_RATIO_POLICY: BenchmarkComparisonPolicyConfig = {
  target: "compression_ratio",
  type: "ratio",
  ratioPolicy: {
    badRatio: 0.95,
    goodRatio: 1.05,
    direction: "up",
  },
};

const ACCURACY_STATUS_POLICY: BenchmarkComparisonPolicyConfig = {
  target: "accuracy",
  type: "status",
};

const DashboardRenderBook = {
  accuracy: {
    displayName: "Accuracy",
  },
  speedup: {
    displayName: "Perf. speedup",
    unit: {
      unit: "x",
    },
  },
  dynamo_peak_mem: {
    displayName: "Dynamo memory usage",
  },
  compilation_latency: {
    displayName: "Compilation time (seconds)",
    unit: {
      type: "time",
      unit: "s",
    },
  },
  compression_ratio: {
    displayName: "Peak mem compress ratio ",
    unit: {
      unit: "x",
    },
  },
  abs_latency: {
    displayName: "Abs. execution time (ms)",
    unit: {
      type: "time",
      unit: "ms",
    },
  },
};

const RENDER_MAPPING_BOOK = {
  passrate: {
    unit: {
      type: "percent",
      unit: "%",
      scale: 100,
    },
  },
  geomean_speedup: {
    unit: {
      unit: "x",
    },
  },
  compilation_latency: {
    displayName: "compilation time",
    unit: {
      type: "time",
      unit: "s",
    },
  },
  compression_ratio: {
    displayName: "compression ratio",
    unit: {
      unit: "x",
    },
  },
  execution_time: {
    displayName: "Execution time ",
    unit: {
      type: "time",
      unit: "s",
    },
  },
  dynamo_peak_mem: {
    displayName: "Dynamo memory usage",
    unit: {
      unit: "mb",
    },
  },
};

export function toQueryArch(device: string, arch: string) {
  if (arch === undefined) return [];
  if (!device) return [];
  switch (device) {
    case "rocm":
      if (arch === "mi300x" || arch == "") return ["mi300x", "mi325x"];
      return [arch];
    default:
      if (arch === "") {
        return [];
      }
      return [arch];
  }
}

export const compilerQueryParameterConverter: QueryParameterConverter = (
  inputs: QueryParameterConverterInputs
) => {
  const i = inputs;
  const f = i.filters;
  const suiteList = getSuites(f.suite);
  const compilerList = getCompilers(f.compiler);

  let workflows: number[] = [];
  if (i.workflows) {
    workflows = toNumberArray(i.workflows);
  }

  let models = getModels(f.model);

  const device = DISPLAY_NAMES_TO_DEVICE_NAMES[f.deviceName];
  const arch = DISPLAY_NAMES_TO_ARCH_NAMES[f.deviceName];
  const arches = toQueryArch(device, arch);

  const params = {
    commits: i.commits ?? [],
    branches: i.branches ?? [],
    workflows: workflows,
    compilers: compilerList,
    arches: arches,
    devices: [device],
    dtypes: f.dtype === "none" ? [] : [f.dtype],
    granularity: "hour",
    modes: [f.mode],
    models: models,
    startTime: dayjs.utc(i.timeRange.start).format("YYYY-MM-DDTHH:mm:ss"),
    stopTime: dayjs.utc(i.timeRange.end).format("YYYY-MM-DDTHH:mm:ss"),
    suites: suiteList,
  };
  return params;
};

export const COMPILTER_PRECOMPUTE_BENCHMARK_ID = "compiler_precompute";

// The initial config for the compiler benchmark regression page
export const COMPILTER_PRECOMPUTE_BENCHMARK_INITIAL = {
  benchmarkId: COMPILTER_PRECOMPUTE_BENCHMARK_ID,
  type: "aggregate",
  apiId: COMPILTER_PRECOMPUTE_BENCHMARK_ID,
  // (elainewy): todo change this to json-friend config
  time: {
    start: dayjs.utc().startOf("day").subtract(7, "day"),
    end: dayjs.utc().endOf("day"),
  },
  filters: {
    repo: "pytorch/pytorch",
    benchmarkName: "compiler",
    backend: "",
    mode: DEFAULT_MODE,
    dtype: MODES[DEFAULT_MODE],
    deviceName: DEFAULT_DEVICE_NAME,
    device: "cuda",
    arch: "h100",
  },
  lbranch: "main",
  rbranch: "main",
  enableSamplingFeature: true,
  maxSampling: 110, // max number of job run results to show in the table, this avoid out of memory issue
};

export const COMPILTER_BENCHMARK_NAME = "compiler_inductor";

const COMPILER_DASHBOARD_BENCHMARK_DATABINDING = {
  initial: {
    ...DEFAULT_DASHBOARD_BENCHMARK_INITIAL,
    ...COMPILTER_PRECOMPUTE_BENCHMARK_INITIAL,
  },
  required_filter_fields: REQUIRED_COMPLIER_LIST_COMMITS_KEYS,
  filter_options: {
    customizedDropdown: {
      type: "component",
      id: "CompilerSearchBarDropdowns",
    },
  },
  query_params: {
    type: "converter",
    id: "compilerQueryParameterConverter",
  },
};

const DASHBOARD_COMPARISON_TABLE_METADATA_COLUMNS = [
  {
    field: "suite",
  },
  {
    field: "compiler",
    displayName: "Backend",
  },
] as const;

// config for the compiler dashboard page
export const CompilerDashboardBenchmarkUIConfig: BenchmarkUIConfig = {
  benchmarkId: COMPILTER_BENCHMARK_NAME,
  apiId: COMPILTER_BENCHMARK_NAME,
  title: "Compiler Inductor Dashboard",
  type: "dashboard",
  dataBinding: COMPILER_DASHBOARD_BENCHMARK_DATABINDING,
  dataRender: {
    type: "auto",
    subSectionRenders: {
      detail_view: {
        renders: [
          {
            type: "AutoBenchmarkTimeSeriesChartGroup",
            title: "Metrics Time Series Chart Detail View",
            config: {
              type: "line",
              groupByFields: ["metric"],
              lineKey: ["model", "compiler", "suite", "branch"],
              chart: {
                renderOptions: {
                  chartRenderBook: DashboardRenderBook,
                  showLegendDetails: true,
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
                ...DASHBOARD_COMPARISON_TABLE_METADATA_COLUMNS,
              ],
              renderOptions: {
                tableRenderingBook: DashboardRenderBook,
              },
            },
          },
        ],
      },
    },
    renders: [
      {
        type: "AutoBenchmarkLogs",
        title: "Logs",
        config: {
          logFields: ["suite", "model"],
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
              applyFilterFields: ["model", "compiler", "suite", "mode"],
            },
          },
          targetField: "metric",
          comparisonPolicy: {
            accuracy: ACCURACY_STATUS_POLICY,
            compilation_latency: COMPILATION_LATENCY_COMPARISON_POLICY,
            compression_ratio: COMPRESSION_RATIO_POLICY,
          },
          extraMetadata: DASHBOARD_COMPARISON_TABLE_METADATA_COLUMNS,
          renderOptions: {
            tableRenderingBook: DashboardRenderBook,
            renderMissing: true,
            flex: {
              primary: 2,
            },
          },
        },
      },
    ],
  },
};

function getModels(model: string | undefined | null) {
  // indicates fetch all compilers
  if (!model) {
    return [];
  }
  if (model == "all") {
    return [];
  }
  return [model];
}

function getCompilers(compiler: string | undefined | null) {
  // indicates fetch all compilers
  if (!compiler) {
    return [];
  }
  if (compiler == "all") {
    return [];
  }
  return DISPLAY_NAMES_TO_COMPILER_NAMES[compiler]
    ? [DISPLAY_NAMES_TO_COMPILER_NAMES[compiler]]
    : [compiler];
}

function getSuites(suite: string | undefined | null) {
  // indicates fetch all suites
  if (!suite) {
    return Object.keys(SUITES);
  }
  return suite == "all" ? Object.keys(SUITES) : [suite];
}

// main config for the compiler benchmark regression page
export const CompilerPrecomputeBenchmarkUIConfig: BenchmarkUIConfig = {
  benchmarkId: COMPILTER_PRECOMPUTE_BENCHMARK_ID,
  apiId: COMPILTER_PRECOMPUTE_BENCHMARK_ID,
  title: "Compiler Inductor Regression Tracking",
  type: "aggregate",
  dataBinding: {
    initial: COMPILTER_PRECOMPUTE_BENCHMARK_INITIAL,
    required_filter_fields: REQUIRED_COMPLIER_LIST_COMMITS_KEYS,
    filter_options: {
      customizedDropdown: {
        type: "component",
        id: "CompilerSearchBarDropdowns",
      },
    },
    query_params: {
      type: "converter",
      id: "compilerQueryParameterConverter",
    },
  },
  dataRender: {
    type: "fanout",
    sideRender: {
      RegressionReportFeature: {
        type: "RegressionReportFeature",
        title: "Regression Report Section",
        config: {
          report_id: "compiler_regression",
        },
      },
    },
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
          groupByFields: ["suite"],
          chartGroup: {
            type: "line",
            groupByFields: ["metric"],
            lineKey: ["compiler", "branch"],
            chart: {
              enableDialog: true,
              customizedConfirmDialog: {
                type: "component",
                id: "CompilerPrecomputeConfirmDialogContent",
              },
              renderOptions: {
                chartRenderBook: RENDER_MAPPING_BOOK,
                title_group_mapping: {
                  passrate: {
                    text: "Passrate",
                  },
                  geomean_speedup: {
                    text: "Geometric mean speedup",
                  },
                  compilation_latency: {
                    text: "compilation time (seconds)",
                  },
                  compression_ratio: {
                    text: "Peak memory footprint compression ratio",
                  },
                  execution_time: {
                    text: "Execution time (seconds)",
                  },
                  dynamo_peak_mem: {
                    text: "Dynamo memory usage (MB)",
                  },
                },
              },
            },
          },
        },
      },
      {
        type: "FanoutBenchmarkTimeSeriesComparisonTableSection",
        title: "Time Series Comparison Table Section",
        config: {
          groupByFields: ["metric"],
          filterByFieldValues: {
            metric: [
              "passrate",
              "geomean_speedup",
              "compilation_latency",
              "compression_ratio",
            ],
          },
          tableConfig: {
            primary: {
              fields: ["compiler"],
              displayName: "Backend",
            },
            enableDialog: true,
            customizedConfirmDialog: {
              type: "component",
              id: "CompilerPrecomputeConfirmDialogContent",
            },
            targetField: "metric",
            comparisonPolicy: {
              passrate: PASSRATE_COMPARISON_POLICY,
              geomean_speedup: GEOMEAN_COMPARISON_POLICY,
              compilation_latency: COMPILATION_LATENCY_COMPARISON_POLICY,
              compression_ratio: COMPRESSION_RATIO_POLICY,
            },
            renderOptions: {
              title_group_mapping: {
                passrate: {
                  text: "Passrate (threshold: 95%)",
                },
                geomean_speedup: {
                  text: "Geometric mean speedup (threshold = 0.95x)",
                },
                compilation_latency: {
                  text: "Compilation time (seconds)",
                },
                compression_ratio: {
                  text: "Peak memory footprint compression ratio (threshold = 0.95x)",
                },
              },
              tableRenderingBook: RENDER_MAPPING_BOOK,
              renderMissing: true,
            },
          },
        },
      },
    ],
  },
};
