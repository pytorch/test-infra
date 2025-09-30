import {
  DEFAULT_DEVICE_NAME,
  DISPLAY_NAMES_TO_ARCH_NAMES,
  DISPLAY_NAMES_TO_DEVICE_NAMES,
} from "components/benchmark/compilers/common";
import { SUITES } from "components/benchmark/compilers/SuitePicker";
import { DEFAULT_MODE, MODES } from "components/benchmark/ModeAndDTypePicker";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { REQUIRED_COMPLIER_LIST_COMMITS_KEYS } from "lib/benchmark/api_helper/compilers/type";
import { BenchmarkUIConfig } from "../../configBook";
import { BenchmarkComparisonPolicyConfig } from "../../helpers/RegressionPolicy";
import {
  QueryParameterConverter,
  QueryParameterConverterInputs,
} from "../../utils/dataBindingRegistration";
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
  target: "geomean",
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
    badRatio: 1.1,
    goodRatio: 0.9,
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

const RENDER_MAPPING_BOOK = {
  passrate: {
    unit: {
      type: "percent",
      unit: "%",
      scale: 100,
    },
  },
  geomean: {
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
};

export const compilerQueryParameterConverter: QueryParameterConverter = (
  inputs: QueryParameterConverterInputs
) => {
  const i = inputs;
  const f = i.filters;
  return {
    commits: i.commits ?? [],
    branches: i.branches ?? [],
    compilers: [],
    arch: DISPLAY_NAMES_TO_ARCH_NAMES[f.deviceName],
    device: DISPLAY_NAMES_TO_DEVICE_NAMES[f.deviceName],
    dtype: f.dtype === "none" ? "" : f.dtype,
    granularity: "hour",
    mode: f.mode,
    startTime: dayjs.utc(i.timeRange.start).format("YYYY-MM-DDTHH:mm:ss"),
    stopTime: dayjs.utc(i.timeRange.end).format("YYYY-MM-DDTHH:mm:ss"),
    suites: f.suite ?? Object.keys(SUITES),
  };
};

export const COMPILTER_PRECOMPUTE_BENCHMARK_ID = "compiler_precompute";

// The initial config for the compiler benchmark regression page
export const COMPILTER_PRECOMPUTE_BENCHMARK_INITIAL = {
  benchmarkId: COMPILTER_PRECOMPUTE_BENCHMARK_ID,
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
};

// main config for the compiler benchmark regression page
export const CompilerPrecomputeBenchmarkUIConfig: BenchmarkUIConfig = {
  benchmarkId: COMPILTER_PRECOMPUTE_BENCHMARK_ID,
  apiId: COMPILTER_PRECOMPUTE_BENCHMARK_ID,
  title: "Compiler Inductor Regression Tracking",
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
      id: "compilerDataRenderConverter",
    },
  },
  dataRender: {
    type: "fanout",
    renders: [
      {
        type: "FanoutBenchmarkTimeSeriesChartSection",
        title: "Time Series Chart Section",
        config: {
          groupByFields: ["suite"],
          chartGroup: {
            type: "line",
            groupByFields: ["metric"],
            lineKey: ["compiler"],
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
                  geomean: {
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
              "geomean",
              "compilation_latency",
              "compression_ratio",
            ],
          },
          tableConfig: {
            nameKeys: ["compiler"],
            enableDialog: true,
            customizedConfirmDialog: {
              type: "component",
              id: "CompilerPrecomputeConfirmDialogContent",
            },
            targetField: "metric",
            comparisonPolicy: {
              passrate: PASSRATE_COMPARISON_POLICY,
              geomean: GEOMEAN_COMPARISON_POLICY,
              compilation_latency: COMPILATION_LATENCY_COMPARISON_POLICY,
              compression_ratio: COMPRESSION_RATIO_POLICY,
            },
            renderOptions: {
              title_group_mapping: {
                passrate: {
                  text: "Passrate (threshold: 95%)",
                },
                geomean: {
                  text: "Geometric mean speedup (threshold = 0.95x)",
                },
                compilation_latency: {
                  text: "compilation time (seconds)",
                },
                compression_ratio: {
                  text: "Peak memory footprint compression ratio (threshold = 0.95x)",
                },
              },
              tableRenderingBook: RENDER_MAPPING_BOOK,
            },
          },
        },
      },
    ],
  },
};
